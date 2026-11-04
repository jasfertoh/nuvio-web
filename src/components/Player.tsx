import type Hls from "hls.js";
import { platform } from "../platform/index.ts";
import { safeHttpUrl } from "../lib/security";
import {
  assessPlayback,
  audioIsSilent,
  shouldUseRemuxFallback,
} from "../lib/playback";
import { MediabunnyPlayer } from "../lib/mediabunnyPlayer";
import { proxiedPlaybackUrl } from "../lib/mediaProxy";
import { deviceSubtitleFontSize } from "../lib/deviceSubtitleSize.ts";
import { ensureProxySignature } from "../lib/proxySignature";
import {
  audioDetail,
  fetchProxySubtitles,
  fetchProxyTracks,
  languageName,
  proxySubtitleUrl,
  prepareSubtitleRelay,
  subtitleRelayUrl,
  trackLabel,
  type ProxyAudioTrack,
  type ProxySubtitleTrack,
} from "../lib/proxyTracks";
import { loadAddonSubtitles, loadStreams, type AddonSubtitle } from "../lib/addons";
import { subtitleRequestIds } from "../lib/subtitleIds";
import {
  offeredInBrowser,
  sortStreams,
  streamLabel,
  streamQuality,
  streamReleaseName,
  streamSeeders,
  streamSizeBytes,
} from "../lib/streamPresentation";
import {
  DEBRID_SHORT_NAME,
  checkDebridCached,
  needsDebridResolve,
} from "../lib/debridResolve";
import type { ProviderCredentialRow } from "../lib/providerCredentials";
import {
  readTitlePreferences,
  rememberTitlePreference,
  titleKey,
} from "../lib/titlePreferences";
import { readableFileSize } from "../lib/webSettings";
import {
  browserColor,
  type ResizeMode,
  type WebPlayerSettings,
} from "../lib/webSettings";
import { subtitleFontStack } from "../lib/subtitleFonts";
import {
  ArrowLeft,
  Copy,
  Eye,
  ExternalLink,
  FastForward,
  Rewind,
  List,
  LoaderCircle,
  Maximize,
  Music2,
  Ratio,
  Layers,
  Pause,
  Play,
  SkipForward,
  Subtitles,
  Sun,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  hasEpisodeAired,
  resolveNextEpisode,
  shouldShowNextEpisode,
} from "../lib/nextEpisode";
import {
  episodePercent,
  remainingShort,
  watchKey,
  type WatchIndex,
} from "../lib/progress";
import { EpisodeRow } from "./Details";
import { Select } from "./Select";
import {
  activeSkipSegment,
  creditsStart,
  loadSkipSegments,
  skipLabel,
  type SkipSegment,
} from "../lib/skipSegments";
import type {
  ExternalPlayerMode,
  InstalledAddon,
  Meta,
  Stream,
  Video,
} from "../types";

// Present only in the desktop shell. Keeping this capability check here makes
// the player chrome shared while the bytes still take the right route: a web
// page decodes in <video>/canvas, and Tauri hands the same source to libmpv.
const nativePlayer = platform.player;

type AudioChoice = { id: number; label: string };
type NativeAudioTrackList = {
  length: number;
  [index: number]: { enabled: boolean; label?: string; language?: string };
};
/** "en-GB" and "eng" both reduce to something two languages can be compared on. */
const normalizeLanguage = (value?: string) =>
  (value || "").trim().toLowerCase().split(/[-_]/)[0];

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

/**
 * Whether the browser lets the whole subtitle layer be moved, which is how the
 * bottom offset is applied where it can be. Pinning each cue to a line instead
 * (snapToLines off) works everywhere, but switches off the browser's stacking:
 * two cues on screen together - two speakers over each other - are then both
 * drawn at the same spot, one on top of the other.
 */
const canShiftCueLayer =
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("selector(video::-webkit-media-text-track-container)");
function formatTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const seconds = Math.floor(value % 60)
    .toString()
    .padStart(2, "0");
  const minutes = Math.floor(value / 60) % 60;
  const hours = Math.floor(value / 3600);
  return hours
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** Runtime reported by Stremio metadata, normalized to seconds. */
function runtimeHintSeconds(meta: Meta, video?: Video) {
  if (typeof video?.runtime === "number" && video.runtime > 0)
    return video.runtime * 60;
  const value = meta.runtime?.trim() ?? "";
  if (!value) return undefined;
  const hours = /(\d+(?:\.\d+)?)\s*h/i.exec(value);
  const minutes = /(\d+(?:\.\d+)?)\s*m/i.exec(value);
  const seconds =
    Number(hours?.[1] ?? 0) * 3600 + Number(minutes?.[1] ?? 0) * 60;
  if (seconds > 0) return seconds;
  const bareMinutes = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : 0;
  return bareMinutes > 0 ? bareMinutes * 60 : undefined;
}

/**
 * What the button cycles through.
 *
 * Three rather than the four `ResizeMode` holds: "Zoom" and "Fill" both come
 * out as `cover`, so putting both in a cycle would give the button a press
 * that visibly does nothing. Zoom is still reachable from Settings and still
 * behaves as it always has.
 */
const ASPECT_MODES: ResizeMode[] = ["Fit", "Fill", "Stretch"];

export function Player({
  stream,
  meta,
  video,
  addons = [],
  onPlayerSetting,
  onSelectStream,
  onClose,
  onExternalPlay,
  onProgress,
  onNativeProgressSnapshot,
  settings,
  startPositionMs = 0,
  episodes,
  watchIndex,
  onPlayEpisode,
  onPrepareEpisode,
  notice = "",
  onDismissNotice,
  profileKey = "0",
  providerCredentials = [],
}: {
  stream: Stream;
  meta: Meta;
  video?: Video;
  /** Asked for subtitles; a standalone file arrives far quicker than one
      demuxed out of the video. */
  addons?: InstalledAddon[];
  /**
   * Persists a change made from the player's own subtitle controls, so it
   * survives the session and reaches the account's other devices.
   */
  onPlayerSetting?(
    key: string,
    type: "int" | "boolean" | "string",
    value: number | boolean | string,
  ): void;
  /**
   * Switch to another source for what is already playing. Raised rather than
   * handled here: a torrent has to be resolved before it can be played, and
   * that belongs with the rest of the resolving.
   */
  onSelectStream?(next: Stream): void | Promise<boolean>;
  onClose(): void;
  /**
   * Hands the stream off to a player outside the browser. Raised rather than
   * launched here: closing this player and recording where it got to are the
   * app's to do, and both have to happen for the handoff to be worth anything.
   */
  onExternalPlay(
    mode: ExternalPlayerMode,
    url: string,
    positionMs: number,
  ): void;
  /** Where to resume from. 0 starts at the beginning. */
  startPositionMs?: number;
  /**
   * The run this episode belongs to, so the player can offer the next one and
   * let another be chosen without leaving playback.
   */
  episodes?: Video[];
  watchIndex?: WatchIndex;
  /** Resolves a source for another episode and switches to it. */
  /**
   * Resolves false when the episode could not be started. The player has
   * already torn its own playback down by then, so it has to be told: without
   * an answer it waits on a source that is never coming.
   */
  onPlayEpisode?(next: Video): void | Promise<boolean>;
  /** Asks the shell to work out what the next episode needs, ahead of time. */
  onPrepareEpisode?(next: Video): void;
  /**
   * A message the shell wants shown. The shell's own notice sits inside the
   * page, which this covers entirely, so anything raised while the player is
   * open would otherwise be painted behind it and never read.
   */
  notice?: string;
  onDismissNotice?(): void;
  /** Which profile is watching, so one person's corrections stay theirs. */
  profileKey?: string;
  /** Needed to tell which torrents Torbox actually holds. */
  providerCredentials?: ProviderCredentialRow[];
  /** Reports a resume point. Fired periodically, on pause, and on exit. */
  onProgress(positionMs: number, durationMs: number, ended: boolean): void;
  /**
   * Mirrors a checkpoint that the native shell is already persisting.
   * Browser playback never calls this; doing so would create a second writer.
   */
  onNativeProgressSnapshot?(
    positionMs: number,
    durationMs: number,
    ended: boolean,
  ): void;
  settings: WebPlayerSettings;
}) {
  const playerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /**
   * The decoding player, when the browser will not take the file directly.
   * While it is set it owns playback entirely, and the <video> element is
   * neither playing nor asked anything.
   */
  const engineRef = useRef<MediabunnyPlayer | null>(null);
  const [errorCopied, setErrorCopied] = useState(false);
  const hideTimer = useRef<number | undefined>(undefined);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  playingRef.current = playing;
  const [waiting, setWaiting] = useState(true);
  const [remuxActive, setRemuxActive] = useState(false);
  /** True while the decoding player owns playback, and the canvas is shown. */
  const [decoding, setDecoding] = useState(false);
  const [warning, setWarning] = useState("");
  useEffect(() => {
    if (!warning) return;
    const timer = window.setTimeout(() => setWarning(""), 6000);
    return () => window.clearTimeout(timer);
  }, [warning]);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const seekPreviewRef = useRef<number | null>(null);
  // libmpv accepts a seek on its command channel before its sampled position
  // catches up.  Keep the requested position authoritative during that short
  // window so polling cannot make the timeline jump target -> old -> target.
  const pendingNativeSeekRef = useRef<{
    targetSeconds: number;
    submittedAt: number;
  } | null>(null);
  const nativeProgressSnapshotRef = useRef({
    positionMs: 0,
    durationMs: 0,
    ended: false,
  });
  // Kept in a ref so the reporting effect can run once for the whole session
  // rather than resubscribing on every timeupdate.
  const reportRef = useRef(onProgress);
  reportRef.current = onProgress;
  const prepareRef = useRef(onPrepareEpisode);
  prepareRef.current = onPrepareEpisode;
  const [volume, setVolume] = useState(() =>
    Number(localStorage.getItem("nuvio-web-volume") ?? 1),
  );
  const [muted, setMuted] = useState(
    () => localStorage.getItem("nuvio-web-muted") === "true",
  );
  /**
   * Nudging the volume, held in a ref because the shortcut effect binds one
   * window listener and should not rebind it on every step of a held key.
   * Assigned below, where the volume control it goes through is defined.
   */
  const nudgeVolume = useRef<(delta: number) => void>(() => {});
  /** Muting from the keyboard, held for the same reason. */
  const muteFromKeyboard = useRef<() => void>(() => {});
  /**
   * How much the picture is lifted, as a CSS brightness multiplier.
   *
   * Not remembered between films. A grade dark enough to need this is a
   * property of the film rather than of the viewer, and a picture left washed
   * out from something watched last week would be a puzzle rather than a
   * setting.
   */
  const [brightness, setBrightness] = useState(1);
  const [brightnessOpen, setBrightnessOpen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsVisibleRef = useRef(controlsVisible);
  controlsVisibleRef.current = controlsVisible;
  /**
   * What a keyboard shortcut just did, shown over the picture for a moment.
   *
   * A key pressed at a hidden player used to act in silence, and answering it
   * by putting the whole control bar back covered the scene to report a
   * change of ten seconds. `at` is the moment it was raised: it keys the
   * element, so a second press restarts the fade rather than continuing the
   * first one's.
   */
  const [hud, setHud] = useState<
    | { kind: "seek"; amount: number; at: number }
    | { kind: "volume"; level: number; muted: boolean; at: number }
    | null
  >(null);
  const hudTimer = useRef(0);
  const showHud = useCallback(
    (next: { kind: "seek"; amount: number } | { kind: "volume"; level: number; muted: boolean }) => {
      setHud((current) =>
        // A run of presses is one gesture, so the overlay reports the whole
        // of it rather than the last ten seconds of it. Signed, so overshoot
        // and correct reads as what actually happened: forward thirty, back
        // ten, twenty seconds.
        next.kind === "seek" && current?.kind === "seek"
          ? { ...next, amount: current.amount + next.amount, at: performance.now() }
          : { ...next, at: performance.now() },
      );
      window.clearTimeout(hudTimer.current);
      // Matches the fade in the stylesheet, so it leaves the tree having
      // already gone rather than vanishing mid-animation.
      hudTimer.current = window.setTimeout(() => setHud(null), 1000);
    },
    [],
  );
  useEffect(() => () => window.clearTimeout(hudTimer.current), []);
  const [audioOpen, setAudioOpen] = useState(false);
  const [subtitleOpen, setSubtitleOpen] = useState(false);
  /** Text tracks on the element, rebuilt whenever the element's list changes. */
  const [subtitleTracks, setSubtitleTracks] = useState<AudioChoice[]>([]);
  /** -1 is subtitles off, which is a choice rather than an absent one. */
  const [selectedSubtitle, setSelectedSubtitle] = useState(-1);
  /**
   * Survives a source reload. Seeking a transcode reloads the stream, and
   * element.load() resets every text track to disabled - so without this the
   * subtitles switched themselves off every time you skipped.
   */
  const selectedSubtitleRef = useRef(-1);
  selectedSubtitleRef.current = selectedSubtitle;
  /**
   * Subtitle delay, in milliseconds, and deliberately not persisted: it
   * corrects one release whose subtitles are timed to a different cut, and
   * carrying that correction into the next film would be wrong every time.
   */
  const [subtitleDelayMs, setSubtitleDelayMs] = useState(0);
  /**
   * A cue's own timings, before any delay. Shifting from the original each
   * time keeps the adjustment absolute rather than accumulating, so dialling
   * back to zero restores exactly what the file said.
   */
  const cueOriginals = useRef(new WeakMap<TextTrackCue, { start: number; end: number }>());
  const [externalPlayerOpen, setExternalPlayerOpen] = useState(false);
  const [episodesOpen, setEpisodesOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  /** Other sources for what is playing, fetched when the list is opened. */
  const [sourceList, setSourceList] = useState<Stream[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  /** Dismissed by hand, so it does not come back for the rest of the episode. */
  const [nextDismissed, setNextDismissed] = useState(false);
  const [skipSegments, setSkipSegments] = useState<SkipSegment[]>([]);
  /** True from choosing an episode until its stream arrives. */
  const [switching, setSwitching] = useState(false);
  /**
   * Ticks so the finish time keeps up while paused.
   *
   * Playing, `currentTime` moves and this recomputes with it. Paused, what is
   * left stops changing but the clock does not, so the finish time has to walk
   * forward on its own — otherwise it silently claims you will finish at a
   * time that passed twenty minutes ago.
   */
  const [clockTick, setClockTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setClockTick((n) => n + 1), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const endsAt = useMemo(() => {
    const left = duration - currentTime;
    if (!Number.isFinite(left) || left <= 0 || duration <= 0) return "";
    void clockTick;
    return new Date(Date.now() + left * 1000).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }, [duration, currentTime, clockTick]);
  const seasons = useMemo(
    () =>
      [...new Set((episodes ?? []).map((item) => item.season ?? 0))].sort(
        (a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b),
      ),
    [episodes],
  );
  const [season, setSeason] = useState<number | undefined>();
  // Opens on the season being watched rather than at the beginning of the run.
  useEffect(() => {
    setSeason(video?.season ?? seasons[0]);
  }, [video?.season, seasons]);
  const seasonEpisodes = useMemo(
    () => (episodes ?? []).filter((item) => (item.season ?? 0) === season),
    [episodes, season],
  );
  const [audioTracks, setAudioTracks] = useState<AudioChoice[]>([]);
  const [selectedAudio, setSelectedAudio] = useState(-1);
  /**
   * Which audio track the proxy should carry. Held here rather than on the
   * element because changing it changes the URL, and the position has to be
   * carried across the reload that follows.
   */
  const [proxyAudioOrdinal, setProxyAudioOrdinal] = useState<number | null>(null);
  /** Kept whole, not flattened to a label: the picker shows codec and channel
      count under the language, the way the TV player does. */
  const [proxyAudio, setProxyAudio] = useState<ProxyAudioTrack[]>([]);
  /**
   * Where the proxy should start the stream. A transcode carries no
   * Content-Length, so the element reports nothing seekable and setting
   * currentTime is simply refused - it snaps back to zero. Seeking such a
   * source means asking the proxy to begin somewhere else instead.
   */
  const [proxyStart, setProxyStart] = useState<{
    /**
     * The source this position was chosen for. Effects run in the order they
     * are declared, and the one that loads the video comes before the one that
     * clears this - so on the next episode the loader saw the new URL with the
     * previous episode's position still set, and started it there before
     * reloading at zero. A position that names its source cannot be applied to
     * a different one, whatever order they run in.
     */
    forUrl: string;
    seconds: number;
    /** Bumped per request: asking for the same second twice is a real second
        ask, and identical state would otherwise be dropped by React and the
        stream never reloaded. */
    nonce: number;
  } | null>(null);
  const proxyStartNonce = useRef(0);
  /**
   * The position a reload is currently fetching, or null when none is.
   *
   * Restarting a transcode throws away everything it has buffered and begins
   * the wait again, so a second ask for a position already loading has to be
   * ignored rather than honoured - otherwise clicking again because "nothing
   * happened" is exactly what stops it ever finishing.
   */
  const pendingSeekReloadRef = useRef<number | null>(null);
  const seekReloadTimer = useRef<number | undefined>(undefined);
  /**
   * The film's real length. A transcoded stream's own `duration` is only what
   * has been produced so far and grows as it plays, which makes for a seek bar
   * that keeps changing scale.
   */
  const [proxyDuration, setProxyDuration] = useState(0);
  const [proxySubtitles, setProxySubtitles] = useState<ProxySubtitleTrack[]>([]);
  /**
   * The file has text subtitles the proxy has not finished extracting. Worth
   * saying: on a feature-length source that pass takes minutes, and an empty
   * subtitle menu in the meantime reads as "this file has none".
   */
  const [subtitlesPending, setSubtitlesPending] = useState(false);
  /** Text tracks the proxy has seen in the file, extracted or not. */
  const [proxyHasTextSubtitles, setProxyHasTextSubtitles] = useState(false);
  /** Extraction is only started once the viewer asks for subtitles. */
  const [subtitlesRequested, setSubtitlesRequested] = useState(false);
  /** Subtitles offered by the installed addons: separate files, so quick. */
  const [addonSubtitles, setAddonSubtitles] = useState<AddonSubtitle[]>([]);
  /** Whether the addons have been asked yet, which decides the fallback. */
  const [addonSubtitlesAsked, setAddonSubtitlesAsked] = useState(false);
  /** Read inside listeners that must not re-bind when the length arrives. */
  const proxyDurationRef = useRef(0);
  proxyDurationRef.current = proxyDuration;
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  // WebView2 must stay opaque until libmpv reports playback-restart.  Before
  // that event its child video window can still be transparent, which would
  // otherwise expose whatever desktop window happens to sit behind Nuvio.
  const [nativeSurfaceReady, setNativeSurfaceReady] = useState(!nativePlayer);
  const url = stream.url;
  const externalUrl = stream.externalUrl || url;
  const proxyStartSeconds =
    proxyStart && proxyStart.forUrl === url ? proxyStart.seconds : null;
  // The subtitle choice is per source too: index 3 of one episode's tracks is
  // not index 3 of the next one's.
  const previousUrlRef = useRef(url);
  if (previousUrlRef.current !== url) {
    previousUrlRef.current = url;
    selectedSubtitleRef.current = -1;
  }

  /**
   * Where this source should begin, fixed the moment the source arrives.
   *
   * `startPositionMs` is derived from the progress rows, and this player is
   * what writes them - so every checkpoint changed the prop, which changed
   * `effectiveStartSeconds`, which is what the effect that loads the source
   * keys on. The source therefore tore itself down and restarted the transcode
   * on every checkpoint; and once one crossed the completion threshold the
   * resume point became 0, so playback restarted from the beginning of the
   * film. Under a stall the checkpoints and the reloads fed each other and it
   * never got anywhere at all.
   *
   * Where to begin is a fact about the moment a source was opened, not a live
   * reading, so it is taken once per source and then held.
   */
  const startLatch = useRef<{ url: string | null; ms: number }>({
    url: null,
    ms: 0,
  });
  if (startLatch.current.url !== (url ?? null)) {
    startLatch.current = { url: url ?? null, ms: startPositionMs };
  }
  const initialStartMs = startLatch.current.ms;

  /**
   * How the frame is fitted to the screen, for this source only.
   *
   * Every stream opens on Fit, which is the only mode that shows the whole
   * frame and so the only one that cannot mislead about what was shot.
   * Cropping is a judgement about the film in front of you - a 2.39:1 feature
   * is worth losing the edges of, the next thing may not be - so the choice
   * lasts as long as the stream does and is not written back to the profile.
   */
  /**
   * Where this title's own corrections live.
   *
   * Keyed on the title, not the episode: a release that runs half a second
   * late does so for the whole run it came from, and re-correcting every
   * episode is exactly the tedium this exists to remove.
   */
  const titlePrefKey = useMemo(
    () => titleKey(profileKey, meta.id),
    [profileKey, meta.id],
  );
  const titlePrefs = useMemo(
    () => readTitlePreferences(titlePrefKey),
    [titlePrefKey],
  );
  /**
   * The title's real length in milliseconds, or 0 when it is not yet known.
   *
   * The proxy's figure, read from the source itself, is the only true one for
   * a transcode: the element's own duration is what ffmpeg has produced so
   * far, which trails the position by a second or two, so recording it writes
   * position === duration - which is what "finished" means. A seekable range
   * means the element holds a whole file and its duration is real; an empty
   * one means a transcode, and then unknown is the honest answer. Nothing
   * treats 0 as finished, where a wrong length always is.
   */
  const knownDurationMs = useCallback(() => {
    const engine = engineRef.current;
    if (engine) return engine.duration * 1000;
    if (proxyDurationRef.current > 0) return proxyDurationRef.current * 1000;
    const element = videoRef.current;
    const seekable = element?.seekable;
    const wholeFile =
      !!seekable && seekable.length > 0 && seekable.end(seekable.length - 1) > 0;
    return wholeFile && Number.isFinite(element?.duration ?? NaN)
      ? (element?.duration ?? 0) * 1000
      : 0;
  }, []);

  /** Read inside the source effect, which keys on the source and not on this. */
  const titlePrefsRef = useRef(titlePrefs);
  titlePrefsRef.current = titlePrefs;
  const rememberForTitle = useCallback(
    (patch: Parameters<typeof rememberTitlePreference>[1]) =>
      rememberTitlePreference(titlePrefKey, patch),
    [titlePrefKey],
  );
  /**
   * This title's subtitle size, over the profile's. Held here rather than
   * written to the profile so that adjusting it for one film does not resize
   * every other; the profile default stays where it is set, in Settings.
   */
  const [titleFontSizeSp, setTitleFontSizeSp] = useState<number | null>(
    titlePrefs.subtitleFontSizeSp ?? null,
  );
  /**
   * This title's size, then this device's, then the profile's. The device sits
   * between the two because a size is a property of how far away the screen
   * is, not of the account: choosing one on a phone used to resize the
   * desktop as well.
   */
  const subtitleFontSizeSp =
    titleFontSizeSp ?? deviceSubtitleFontSize() ?? settings.subtitleFontSizeSp;

  const [aspectMode, setAspectMode] = useState<ResizeMode>("Fit");

  /** Whether this source is going through the proxy at all. */
  const proxiedPlayback = useMemo(
    () => Boolean(url) && proxiedPlaybackUrl(url!) !== url,
    [url],
  );
  /**
   * Where the stream should actually begin.
   *
   * Resuming used to be done by seeking once the video had loaded, which works
   * on a file and not at all on a transcode - the element refuses, and playback
   * started from the beginning. Asking the proxy to start there means the first
   * request is already in the right place, with no reload and nothing to seek.
   */
  const effectiveStartSeconds =
    proxyStartSeconds ??
    (proxiedPlayback && initialStartMs > 0 ? initialStartMs / 1000 : null);
  /** Read inside seekTo, which must not re-bind when the source changes. */
  /**
   * The source, if any, being re-encoded because this browser could not decode
   * it as it came. Held per-URL so switching sources starts fresh, and set
   * only once per source - a second decode failure after re-encoding is a real
   * one and should be reported rather than retried forever.
   */
  const [reencodeFor, setReencodeFor] = useState("");
  const proxiedPlaybackRef = useRef(false);
  proxiedPlaybackRef.current = proxiedPlayback;
  const navigableExternalUrl = useMemo(
    () => safeHttpUrl(externalUrl),
    [externalUrl],
  );
  const sourceText = `${stream.name} ${stream.title} ${stream.description} ${stream.behaviorHints?.filename ?? ""}`;
  const riskyAudio = useMemo(
    () => /truehd|dts(?:-hd)?|e-?ac-?3|dd\+|atmos|\.mkv\b/i.test(sourceText),
    [sourceText],
  );
  const videoFit =
    aspectMode === "Stretch"
      ? "fill"
      : aspectMode === "Fit"
        ? "contain"
        : "cover";
  const cueCss = useMemo(() => {
    const color = browserColor(settings.subtitleTextColor, "#fff");
    const background = browserColor(
      settings.subtitleBackgroundColor,
      "transparent",
    );
    const outline = browserColor(settings.subtitleOutlineColor, "#000");
    const width = clamp(settings.subtitleOutlineWidth, 0, 10);
    // A stroke is drawn centred on the glyph outline, so the fill painted over
    // it hides the inner half and a 2px stroke reads as 1px - which is why
    // white text disappeared against a bright scene. Doubling it means the
    // setting is the width actually visible.
    //
    // The shadow is a tight dark halo rather than a soft drop: it closes the
    // gap the stroke cannot reach on a thin diagonal, and it darkens the
    // pixels immediately around the text so there is contrast to read against
    // whatever is behind it. Both scale together, so a higher setting is a
    // heavier outline rather than only a wider one. Past about three the
    // counters in a, e and o begin to fill, so the cap stays where it is.
    const drawn = width * 2;
    const shadow = settings.subtitleOutlineEnabled
      ? `0 0 ${width + 2}px ${outline}, 0 1px ${width}px ${outline}`
      : "none";
    const stroke = settings.subtitleOutlineEnabled
      ? `-webkit-text-stroke:${drawn}px ${outline}; paint-order:stroke fill;`
      : "";
    const fontSize = clamp(subtitleFontSizeSp, 6, 40);
    // Stated as a length rather than a multiplier: the setting is in pixels of
    // extra room, so it means the same thing whatever the font size is. The
    // floor is half the font size, only there so a small font and a very
    // negative setting cannot stack the lines into one; flooring at the font
    // size itself left every value below about -5 looking the same as -5.
    const lineHeight = Math.max(
      fontSize * 0.5,
      fontSize * 1.2 + clamp(settings.subtitleLineSpacing, -12, 24),
    );
    // A face is always named rather than left to the browser's default cue
    // font, which on Chrome is a condensed serif that renders poorly at this
    // size. Which face is a setting; the reason for naming one is not.
    // Chrome leaves about 8px under the text before any offset, so a negative
    // setting can come down that far and no further, as it always could.
    const layerShift = canShiftCueLayer
      ? ` .player-view video::-webkit-media-text-track-container { transform:translateY(${-clamp(settings.subtitleBottomOffset, -8, 600)}px); }`
      : "";
    return `.player-view video::cue { color:${color}; background:${background}; font-family:${subtitleFontStack(settings.subtitleFontFamily)}; font-size:${fontSize}px; line-height:${lineHeight}px; font-weight:${settings.subtitleBold ? 700 : 400}; text-shadow:${shadow}; ${stroke} -webkit-font-smoothing:antialiased; }${layerShift}`;
  }, [settings, subtitleFontSizeSp]);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    window.clearTimeout(hideTimer.current);
    const running = nativePlayer
      ? playingRef.current
      : engineRef.current
        ? !engineRef.current.paused
        : videoRef.current && !videoRef.current.paused;
    if (running)
      hideTimer.current = window.setTimeout(() => {
        setAudioOpen(false);
        setExternalPlayerOpen(false);
        setBrightnessOpen(false);
        setControlsVisible(false);
      }, 3000);
  }, []);
  /**
   * Restart the hide timer without summoning the controls.
   *
   * A seek from the bar or a button happens while they are already up, where
   * this does exactly what showControls did. The keyboard is the case that
   * differs: it answers with the overlay instead, and a hidden player stays
   * hidden.
   */
  const keepControlsUp = useCallback(() => {
    if (controlsVisibleRef.current) showControls();
  }, [showControls]);
  const togglePlayback = useCallback(async () => {
    showControls();
    if (nativePlayer) {
      const next = !playingRef.current;
      setPlaying(next);
      try {
        await nativePlayer.togglePause();
      } catch (reason) {
        setPlaying(!next);
        setError(reason instanceof Error ? reason.message : "Could not control playback.");
      }
      return;
    }
    const engine = engineRef.current;
    if (engine) {
      // Reached from a real tap, which is what lets Safari start the audio
      // context at all.
      if (engine.paused) await engine.play();
      else engine.pause();
      setPlaying(!engine.paused);
      return;
    }
    const element = videoRef.current;
    if (!element) return;
    if (element.paused) {
      try {
        await element.play();
        setError("");
      } catch {
        setStatus("Playback needs another tap or this codec is not supported.");
      }
    } else element.pause();
  }, [showControls]);
  /**
   * A seekable range is what the element will actually honour. An empty one
   * means a stream with no Content-Length - a live transcode - where setting
   * currentTime silently returns to the start.
   */
  const canElementSeekTo = (element: HTMLVideoElement, target: number) => {
    const ranges = element.seekable;
    if (!ranges?.length) return false;
    for (let index = 0; index < ranges.length; index += 1) {
      if (target >= ranges.start(index) && target <= ranges.end(index)) return true;
    }
    return false;
  };

  const seekTo = useCallback(
    async (requested: number) => {
      if (nativePlayer) {
        const maximum = duration > 0
          ? Math.max(0, duration - 0.05)
          : Math.max(0, requested);
        const target = clamp(requested, 0, maximum);
        seekPreviewRef.current = null;
        setSeekPreview(null);
        pendingNativeSeekRef.current = {
          targetSeconds: target,
          submittedAt: performance.now(),
        };
        setCurrentTime(target);
        setWaiting(true);
        keepControlsUp();
        try {
          await nativePlayer.seek(Math.round(target * 1000));
        } catch (reason) {
          pendingNativeSeekRef.current = null;
          setWaiting(false);
          setError(reason instanceof Error ? reason.message : "Could not seek.");
        }
        return;
      }
      const engine = engineRef.current;
      const element = videoRef.current;
      // The proxy's figure when it has one. A transcode's own duration is
      // only what it has produced so far, and it is finite - so clamping to it
      // pinned every forward seek to a few seconds ahead of the playhead while
      // the bar, drawn from the real length, let the viewer aim anywhere.
      const known = proxyDurationRef.current;
      const total =
        engine ? engine.duration : known > 0 ? known : element?.duration ?? 0;
      const maximum = Number.isFinite(total)
        ? Math.max(0, total - 0.05)
        : Math.max(0, requested);
      const target = clamp(requested, 0, maximum);
      seekPreviewRef.current = null;
      setSeekPreview(null);
      keepControlsUp();

      if (engine) {
        setCurrentTime(target);
        setWaiting(true);
        await engine.seek(target);
        return;
      }
      if (!element) return;
      // Shown straight away rather than waiting for the browser to admit it is
      // stalling, which it only does once the gap is already noticeable.
      setWaiting(true);

      // A transcode has no Content-Length, so the element's seekable range is
      // empty and assigning currentTime is refused - playback snaps back to
      // the start. Ask the proxy to begin at the new point instead. Because
      // it hands back the film's own timestamps, the element's clock stays
      // the film's clock across the reload and nothing needs adjusting.
      if (proxiedPlaybackRef.current && !canElementSeekTo(element, target)) {
        setCurrentTime(target);
        const pending = pendingSeekReloadRef.current;
        if (pending !== null && Math.abs(pending - target) < 2) return;
        pendingSeekReloadRef.current = target;
        // Dragging the bar reports every position it passes over. Settling
        // first means one transcode for the gesture rather than one per step.
        window.clearTimeout(seekReloadTimer.current);
        seekReloadTimer.current = window.setTimeout(() => {
          proxyStartNonce.current += 1;
          setProxyStart({
            forUrl: url ?? "",
            seconds: target,
            nonce: proxyStartNonce.current,
          });
        }, 350);
        return;
      }

      element.currentTime = target;
      setCurrentTime(target);
    },
    // `url` is read to stamp which source a start position belongs to. Without
    // it here the callback keeps the previous episode's URL after a switch, the
    // stamp no longer matches, and the seek is discarded - the episode restarts
    // from the beginning instead of moving.
    [duration, keepControlsUp, remuxActive, url],
  );
  const seekBy = useCallback(
    (amount: number) => {
      // Stepped from where playback is heading, not from where it is. A seek
      // on a transcode leaves the element's clock where it was for the seconds
      // the reload takes, so stepping from the element recomputed the same
      // target on every press and the reload dedupe then discarded it: tapping
      // the arrow key five times moved ten seconds, and holding it moved
      // nothing at all. Both pending targets already exist for the sake of the
      // display; this reads them for the arithmetic too.
      const from = nativePlayer
        ? pendingNativeSeekRef.current?.targetSeconds ?? currentTime
        : pendingSeekReloadRef.current ??
          engineRef.current?.currentTime ??
          videoRef.current?.currentTime;
      if (from === undefined) return;
      void seekTo(from + amount);
    },
    [currentTime, seekTo],
  );
  /**
   * Mute, wherever playback actually is.
   *
   * This went to the video element, which the decoding player never touches —
   * so the button did nothing on exactly the streams that need that player,
   * while dragging the slider to zero still worked because that goes through
   * setPlayerVolume.
   */
  const toggleMuted = useCallback(() => {
    if (nativePlayer) {
      setMuted((value) => !value);
      void nativePlayer.toggleMute().catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "Could not change mute."),
      );
      return;
    }
    const engine = engineRef.current;
    if (engine) {
      const next = !muted;
      engine.setMuted(next);
      setMuted(next);
      return;
    }
    const element = videoRef.current;
    if (element) element.muted = !element.muted;
  }, [muted]);
  const toggleFullscreen = useCallback(async () => {
    if (nativePlayer?.setFullscreen) {
      const next = !nativeFullscreen;
      try {
        await nativePlayer.setFullscreen(next);
        setNativeFullscreen(next);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Could not change fullscreen mode.");
      }
      return;
    }
    const container = playerRef.current;
    const element = videoRef.current as
      (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (!container || !element) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (container.requestFullscreen) await container.requestFullscreen();
    else element.webkitEnterFullscreen?.();
  }, [nativeFullscreen]);

  useEffect(() => {
    if (!nativePlayer) return;
    const sourceUrl = url || externalUrl;
    if (!sourceUrl) {
      setWaiting(false);
      setError("This source does not provide a playable URL.");
      return;
    }

    let live = true;
    let polling = false;
    const transparentRoots = [document.documentElement, document.body];
    transparentRoots.forEach((node) => node.classList.add("native-player-active"));
    setSwitching(false);
    setNextDismissed(false);
    setStatus("");
    setError("");
    setWarning("");
    setWaiting(true);
    setPlaying(false);
    setNativeSurfaceReady(false);
    pendingNativeSeekRef.current = null;
    nativeProgressSnapshotRef.current = {
      positionMs: 0,
      durationMs: 0,
      ended: false,
    };

    const refresh = async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await nativePlayer.state();
        if (!live) return;
        nativeProgressSnapshotRef.current = {
          positionMs: Math.max(0, next.positionMs),
          durationMs: Math.max(0, next.durationMs),
          ended: next.ended,
        };
        setWaiting(next.loading);
        setPlaying(next.active && !next.paused && !next.ended);
        if (next.active && !next.loading && !next.error) {
          setNativeSurfaceReady(true);
        }
        const sampledSeconds = Math.max(0, next.positionMs) / 1000;
        const pendingSeek = pendingNativeSeekRef.current;
        if (pendingSeek) {
          const confirmed =
            Math.abs(sampledSeconds - pendingSeek.targetSeconds) < 2.5;
          const expired = performance.now() - pendingSeek.submittedAt > 5_000;
          if (confirmed || expired) {
            pendingNativeSeekRef.current = null;
            setCurrentTime(sampledSeconds);
          } else {
            setCurrentTime(pendingSeek.targetSeconds);
          }
        } else {
          setCurrentTime(sampledSeconds);
        }
        setDuration(Math.max(0, next.durationMs) / 1000);
        setVolume(clamp(next.volume / 100, 0, 1));
        setMuted(next.muted);
        setError(next.error ?? "");
        if (next.warning) setWarning(next.warning);
        const tracks = next.tracks
          .filter((track) => track.kind === "audio")
          .map((track) => ({
            id: track.id,
            label: track.title || track.lang || `Audio ${track.id}`,
          }));
        setAudioTracks(tracks);
        setSelectedAudio(next.audioTrack);
      } catch (reason) {
        if (live)
          setError(reason instanceof Error ? reason.message : "Could not read native player state.");
      } finally {
        polling = false;
      }
    };

    const rememberedVolume = clamp(
      Number(localStorage.getItem("nuvio-web-volume") ?? 1),
      0,
      1,
    );
    const rememberedMuted =
      localStorage.getItem("nuvio-web-muted") === "true";
    void nativePlayer
      .open({
        url: sourceUrl,
        externalUrl,
        title: video?.title || meta.name,
        mediaId: video?.title || meta.name,
        startPositionMs: initialStartMs,
        requestHeaders: stream.behaviorHints?.proxyHeaders?.request,
        progress: {
          contentId: meta.id,
          contentType: meta.type,
          videoId: video?.id ?? meta.id,
          season: video?.season,
          episode: video?.episode,
        },
      })
      .then(async () => {
        await nativePlayer.setVolume(Math.round(rememberedVolume * 100));
        if (rememberedMuted) await nativePlayer.toggleMute();
        await refresh();
      })
      .catch((reason: unknown) => {
        if (!live) return;
        setWaiting(false);
        setError(reason instanceof Error ? reason.message : "libmpv could not open this source.");
      });
    const timer = window.setInterval(refresh, 350);

    return () => {
      live = false;
      window.clearInterval(timer);
      transparentRoots.forEach((node) => node.classList.remove("native-player-active"));
    };
  }, [
    externalUrl,
    meta.id,
    meta.name,
    meta.type,
    initialStartMs,
    stream.behaviorHints?.proxyHeaders?.request,
    url,
    video?.episode,
    video?.id,
    video?.season,
    video?.title,
  ]);

  /**
   * The source a signature has been sought for. The playback effect waits on
   * this: it tears the element down and reloads it, so it must not run once
   * unsigned and again a moment later signed - that would be a restart, and
   * one the viewer would see.
   */
  const [signatureSettled, setSignatureSettled] = useState("");
  useEffect(() => {
    if (!url) return;
    let live = true;
    void ensureProxySignature(url).finally(() => {
      if (live) setSignatureSettled(url);
    });
    return () => {
      live = false;
    };
  }, [url]);

  useEffect(() => {
    if (nativePlayer) return;
    const element = videoRef.current;
    // One round trip to the backend, and only when this source has not been
    // signed already - the sources panel and the track list both mint the
    // same signature, so by the time playback starts it is usually in hand.
    if (url && signatureSettled !== url) return;
    if (!element || !url) {
      setWaiting(false);
      setError("This source does not provide a direct browser video URL.");
      return;
    }
    let disposed = false;
    setSwitching(false);
    let audioWatch: number | undefined;
    let preferredAudioApplied = false;
    let preferredSubtitleApplied = false;
    const isHls = /\.m3u8(?:$|\?)/i.test(url);
    const fail = () => {
      // A decode failure is not the same as a format this browser cannot play.
      // MEDIA_ERR_DECODE means the stream arrived and the decoder refused it
      // partway - VideoToolbox does this to Blu-ray remuxes with
      // kVTVideoDecoderBadDataErr while playing the same film's WEB-DL
      // happily. The picture is copied rather than re-encoded, so whatever the
      // decoder objects to came straight from the file.
      //
      // Worth one retry with the proxy re-encoding, resumed where it stopped.
      // Once per source: if a re-encoded stream fails to decode too, that is a
      // real failure and saying so is better than looping.
      if (
        element.error?.code === MediaError.MEDIA_ERR_DECODE &&
        proxiedPlaybackRef.current &&
        url &&
        reencodeFor !== url
      ) {
        const resumeAt = element.currentTime;
        setStatus("Re-encoding this source for your browser…");
        setReencodeFor(url);
        proxyStartNonce.current += 1;
        setProxyStart({
          forUrl: url,
          seconds: resumeAt,
          nonce: proxyStartNonce.current,
        });
        return;
      }
      setWaiting(false);
      setStatus("");
      setError(
        "The browser could not play this video or audio format. Try the external player option.",
      );
    };
    const languageTargets = (
      primary: string,
      secondary: string,
      includeOriginal: boolean,
    ) => {
      const device = navigator.languages?.length
        ? navigator.languages
        : [navigator.language];
      const requested: string[] =
        primary === "device"
          ? [...device]
          : primary === "original" && includeOriginal
            ? [meta.language || "", ...device]
            : [primary];
      if (secondary) requested.push(secondary);
      return requested.map(normalizeLanguage).filter(Boolean);
    };
    const preferredTrack = (
      tracks: Array<{ language?: string; label?: string }>,
      targets: string[],
    ) => {
      for (const target of targets) {
        const exact = tracks.findIndex(
          (track) => normalizeLanguage(track.language) === target,
        );
        if (exact >= 0) return exact;
        const labelled = tracks.findIndex((track) =>
          (track.label || "").toLowerCase().includes(target),
        );
        if (labelled >= 0) return labelled;
      }
      return -1;
    };
    const syncNativeAudio = () => {
      const list = (
        element as HTMLVideoElement & { audioTracks?: NativeAudioTrackList }
      ).audioTracks;
      if (!list?.length) return;
      const choices = Array.from({ length: list.length }, (_, index) => ({
        id: index,
        label:
          list[index].label || list[index].language || `Audio ${index + 1}`,
      }));
      setAudioTracks(choices);
      if (!preferredAudioApplied) {
        const preferred = preferredTrack(
          Array.from({ length: list.length }, (_, index) => list[index]),
          languageTargets(
            settings.preferredAudioLanguage,
            settings.secondaryPreferredAudioLanguage,
            true,
          ),
        );
        if (preferred >= 0) {
          for (let index = 0; index < list.length; index += 1)
            list[index].enabled = index === preferred;
        }
        preferredAudioApplied = true;
      }
      setSelectedAudio(
        choices.find((choice) => list[choice.id].enabled)?.id ?? 0,
      );
    };
    const syncNativeSubtitles = () => {
      const list = element.textTracks;
      if (!list.length || preferredSubtitleApplied) return;
      preferredSubtitleApplied = true;
      // A choice already made outranks the preferred-language default, and has
      // to be re-applied because loading a source disables every track.
      if (selectedSubtitleRef.current >= 0) {
        const chosen = selectedSubtitleRef.current;
        for (let index = 0; index < list.length; index += 1) {
          list[index].mode = "disabled";
        }
        // Off, then on a beat later. Reloading the source leaves whatever cue
        // was on screen painted over the new stream, and assigning "showing"
        // to a track that is already showing changes nothing - so the stale
        // line stayed there. Going through "disabled" is what drops it.
        window.setTimeout(() => {
          if (list[chosen]) list[chosen].mode = "showing";
        }, 50);
        return;
      }
      const preferred = settings.preferredSubtitleLanguage;
      const targets =
        preferred === "none"
          ? []
          : languageTargets(
              preferred,
              settings.secondaryPreferredSubtitleLanguage,
              false,
            );
      const selected = preferredTrack(
        Array.from({ length: list.length }, (_, index) => list[index]),
        targets,
      );
      for (let index = 0; index < list.length; index += 1)
        list[index].mode = index === selected ? "showing" : "disabled";
    };
    element.volume = clamp(Number.isFinite(volume) ? volume : 1, 0, 1);
    element.muted = muted;
    element.playsInline = true;
    const onPlaying = () => {
      setPlaying(true);
      setWaiting(false);
      setStatus("");
      showControls();
    };
    const onPause = () => {
      setPlaying(false);
      setControlsVisible(true);
      window.clearTimeout(hideTimer.current);
    };
    const onWaiting = () => {
      // No status text: the centre spinner already says this, and showing
      // both read as two separate loading indicators stacked on each other.
      setWaiting(true);
    };
    const onCanPlay = () => {
      setWaiting(false);
      setStatus("");
    };
    // Seek once, on the first metadata event: setting currentTime before the
    // duration is known is silently ignored, and re-seeking on every event
    // would fight the user. Remuxed playback restarts conversion from the
    // Matroska cue instead of downloading linearly from zero to the resume
    // point.
    // Asking the proxy to start part-way in is a request, not a guarantee.
    // Where the audio already plays in a browser the proxy relays the file
    // untouched, and that path ignores `start` entirely and serves from the
    // first byte - so trusting the request meant an AAC source silently
    // resumed at the beginning while an AC-3 one, which is transcoded and does
    // honour it, resumed correctly. What the element reports is the only
    // reliable account of where it actually is.
    let resumed = initialStartMs <= 0;
    const onResume = () => {
      if (resumed) return;
      const target = initialStartMs / 1000;
      // Already there: a transcode restarted at this point hands back the
      // film's own timestamps, so its clock is right on arrival.
      if (element.currentTime >= target - 5) {
        resumed = true;
        return;
      }
      // A transcode's `duration` is only what it has produced so far and its
      // seekable range is empty, so neither can answer yet. Waiting costs
      // nothing: this runs again on canplay.
      if (!Number.isFinite(element.duration)) return;
      if (!canElementSeekTo(element, target)) return;
      resumed = true;
      // Never seek past the end; a stale row from a different cut of the same
      // episode would otherwise drop playback at the credits.
      if (target < element.duration - 5) element.currentTime = target;
    };
    const clearPendingReload = () => {
      pendingSeekReloadRef.current = null;
    };
    element.addEventListener("loadeddata", clearPendingReload);
    // If the stream never arrives, the block must not outlive it - otherwise
    // one failed seek would make the bar dead for the rest of the session.
    const pendingReloadSafety = window.setTimeout(clearPendingReload, 45_000);
    element.addEventListener("loadedmetadata", onResume);
    element.addEventListener("canplay", onResume);
    const onTime = () => {
      // A seek on a transcode does not move the element - it reloads the
      // source, and until the new stream arrives the old one keeps reporting
      // the position it was already at. Letting that through dragged the bar
      // straight back to where the seek started, so a click looked like it had
      // been refused; only a second click, landing while the element was
      // between streams and reporting nothing, appeared to work. The pending
      // target is the truth for as long as there is one, which is the same
      // rule the native path already follows for its own seeks.
      if (pendingSeekReloadRef.current !== null) return;
      setCurrentTime(element.currentTime || 0);
    };
    const onDuration = () => {
      // A transcode reports only what it has produced so far, so the proxy's
      // figure - read from the source itself - is the one to trust when there
      // is one.
      setDuration((current) => {
        if (proxyDurationRef.current > 0) return proxyDurationRef.current;
        return Number.isFinite(element.duration) ? element.duration : current;
      });
      syncNativeAudio();
      syncNativeSubtitles();
    };
    const onVolume = () => {
      setVolume(element.volume);
      setMuted(element.muted);
    };
    element.addEventListener("playing", onPlaying);
    element.addEventListener("pause", onPause);
    element.addEventListener("waiting", onWaiting);
    element.addEventListener("canplay", onCanPlay);
    element.addEventListener("timeupdate", onTime);
    element.addEventListener("durationchange", onDuration);
    element.addEventListener("loadedmetadata", onDuration);
    element.addEventListener("volumechange", onVolume);
    element.addEventListener("error", fail);

    const cleanup = () => {
      disposed = true;
      setRemuxActive(false);
      window.clearTimeout(hideTimer.current);
      element.removeEventListener("playing", onPlaying);
      element.removeEventListener("pause", onPause);
      element.removeEventListener("waiting", onWaiting);
      element.removeEventListener("canplay", onCanPlay);
      element.removeEventListener("loadedmetadata", onResume);
      element.removeEventListener("canplay", onResume);
      element.removeEventListener("loadeddata", clearPendingReload);
      window.clearTimeout(pendingReloadSafety);
      element.removeEventListener("timeupdate", onTime);
      element.removeEventListener("durationchange", onDuration);
      element.removeEventListener("loadedmetadata", onDuration);
      element.removeEventListener("volumechange", onVolume);
      element.removeEventListener("error", fail);
      if (audioWatch !== undefined) window.clearInterval(audioWatch);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      element.pause();
      element.removeAttribute("src");
      element.load();
    };

    // Decode it ourselves rather than asking the browser to accept the file.
    // Media Source refuses these streams for reasons unrelated to whether the
    // machine can decode them, so the container is skipped entirely: frames go
    // to a canvas and audio to Web Audio.
    // When a media proxy is configured this is what the element actually
    // loads: the proxy relays a playable source untouched and re-encodes only
    // audio the browser has no decoder for. Either way what arrives is an
    // ordinary file, so neither the Matroska warnings nor the decode engine
    // apply - the container the source happens to use is no longer what the
    // browser sees.
    const playbackUrl = proxiedPlaybackUrl(url, {
      audioOrdinal: proxyAudioOrdinal,
      startSeconds: effectiveStartSeconds,
      reencode: reencodeFor === url,
    });
    const proxied = playbackUrl !== url;
    const verdict = proxied
      ? { playable: true, audioRisk: false, reason: "" }
      : assessPlayback(url, sourceText);
    if (!proxied && shouldUseRemuxFallback(url, sourceText)) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      setRemuxActive(true);
      setDecoding(true);
      const engine = new MediabunnyPlayer(
        url,
        canvas,
        (next) => {
          if (disposed) return;
          if (next.state === "error") {
            setWaiting(false);
            setStatus("");
            setError(next.message);
          } else if (next.state === "ready" || next.state === "ended") {
            setWaiting(false);
            setStatus("");
            if (next.state === "ended") setPlaying(false);
          } else {
            setWaiting(true);
            setStatus(next.message);
          }
        },
        {
          requestHeaders: stream.behaviorHints?.proxyHeaders?.request,
          startPositionSeconds: initialStartMs / 1000,
          // A file's first audio track is not its main one. Without this a
          // release that happens to list French first plays French.
          preferredLanguages: languageTargets(
            settings.preferredAudioLanguage,
            settings.secondaryPreferredAudioLanguage,
            true,
          ),
          onAudioTracks: (tracks, selected) => {
            if (disposed) return;
            setAudioTracks(tracks);
            setSelectedAudio(selected);
          },
          onTime: (position, total) => {
            if (disposed) return;
            setCurrentTime(position);
            if (total) setDuration(total);
          },
          onEnded: () => {
            if (!disposed) setPlaying(false);
          },
        },
      );
      engineRef.current = engine;
      engine.setVolume(volume);
      engine.setMuted(muted);
      void engine
        .start()
        .then(() => {
          if (disposed) return;
          // Autoplay without a gesture is refused on iOS and increasingly
          // elsewhere; the centre button is then the gesture.
          void engine.play().then(() => setPlaying(!engine.paused));
        })
        .catch((reason: unknown) => {
          if (disposed) return;
          setWaiting(false);
          setError(
            reason instanceof Error
              ? reason.message
              : "This source could not be read.",
          );
        });
      return () => {
        disposed = true;
        engineRef.current = null;
        engine.stop();
      };
    }
    if (!verdict.playable) {
      setError(verdict.reason);
      setWaiting(false);
      return cleanup;
    }

    // Chromium reports no error for an audio codec it cannot decode; it just
    // plays silence. Sample the decoded-byte counters once playback is under
    // way and say so plainly.
    audioWatch = window.setInterval(() => {
      if (element.paused || element.currentTime < 1.5) return;
      if (audioIsSilent(element)) {
        setWarning(
          verdict.reason ||
            "No audio track could be decoded by this browser. Try an external player.",
        );
        window.clearInterval(audioWatch);
      }
    }, 1200);
    if (isHls && element.canPlayType("application/vnd.apple.mpegurl")) {
      element.src = playbackUrl;
      element.load();
      element.play().catch(() => setStatus("Tap play to start"));
    } else if (isHls) {
      import("hls.js")
        .then(({ default: HlsClass }) => {
          if (disposed) return;
          if (!HlsClass.isSupported()) {
            fail();
            return;
          }
          const hls = new HlsClass({
            enableWorker: true,
            lowLatencyMode: false,
          });
          hlsRef.current = hls;
          hls.loadSource(url);
          hls.attachMedia(element);
          const syncTracks = () => {
            const tracks = hls.audioTracks.map((track, index) => ({
              id: index,
              label: track.name || track.lang || `Audio ${index + 1}`,
            }));
            setAudioTracks(tracks);
            if (!preferredAudioApplied) {
              const preferred = preferredTrack(
                hls.audioTracks.map((track) => ({
                  language: track.lang,
                  label: track.name,
                })),
                languageTargets(
                  settings.preferredAudioLanguage,
                  settings.secondaryPreferredAudioLanguage,
                  true,
                ),
              );
              if (preferred >= 0) hls.audioTrack = preferred;
              preferredAudioApplied = true;
            }
            setSelectedAudio(hls.audioTrack);
          };
          hls.on(HlsClass.Events.MANIFEST_PARSED, () => {
            syncTracks();
            element.play().catch(() => setStatus("Tap play to start"));
          });
          hls.on(HlsClass.Events.AUDIO_TRACKS_UPDATED, syncTracks);
          hls.on(HlsClass.Events.AUDIO_TRACK_SWITCHED, (_, data) =>
            setSelectedAudio(data.id),
          );
          hls.on(HlsClass.Events.ERROR, (_, data) => {
            if (data.fatal) fail();
          });
        })
        .catch(fail);
    } else {
      element.src = playbackUrl;
      element.load();
      element.play().catch(() => setStatus("Tap play to start"));
    }
    return cleanup;
    // Volume is initialized once per source; UI changes update the element directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // Deliberately NOT `settings`: this effect tears the source down and
    // reloads it, and the object's identity changes whenever any setting is
    // written - so adjusting subtitle size restarted the film from the
    // beginning. Only the values this effect actually reads at mount belong
    // here; the rest are applied by their own effects while playback runs.
  }, [
    url,
    signatureSettled,
    proxyAudioOrdinal,
    proxyStart,
    reencodeFor,
    showControls,
    settings.preferredAudioLanguage,
    settings.secondaryPreferredAudioLanguage,
    settings.preferredSubtitleLanguage,
    settings.secondaryPreferredSubtitleLanguage,
    effectiveStartSeconds,
    meta.language,
  ]);


  // What the proxy can tell us about this source: its audio tracks, its
  // embedded subtitles, and its real length. Read out of the transcode the
  // proxy is running anyway, so asking costs the source nothing.
  useEffect(() => {
    setNextDismissed(false);
    setSourcesOpen(false);
    setSourceList([]);
    setAspectMode("Fit");
    setProxyStart(null);
    setProxyDuration(0);
    setProxyAudio([]);
    setProxySubtitles([]);
    // Not zero: this title's own correction, if it has one.
    setSubtitleDelayMs(readTitlePreferences(titleKey(profileKey, meta.id)).subtitleDelayMs ?? 0);
    setSubtitlesPending(false);
    setProxyHasTextSubtitles(false);
    setSubtitlesRequested(false);
    setAddonSubtitles([]);
    setAddonSubtitlesAsked(false);
    subtitleAutoApplied.current = false;
    setProxyAudioOrdinal(null);
    // A stream may carry only an externalUrl, in which case there is nothing
    // here to ask about.
    if (!url || proxiedPlaybackUrl(url) === url) return;
    const source = url;
    const abort = new AbortController();
    void fetchProxyTracks(source, abort.signal)
      .then((tracks) => {
        if (!tracks || abort.signal.aborted) return;
        if (tracks.durationSeconds > 0) setProxyDuration(tracks.durationSeconds);
        if (tracks.audio.length > 1) {
          setProxyAudio(tracks.audio);
          setAudioTracks(
            tracks.audio.map((track, index) => ({
              id: track.ordinal,
              label: trackLabel(track, index, "Audio"),
            })),
          );
          // The language chosen last time beats the file's own default: a
          // release that lists eight Russian dubs first should not keep
          // starting in Russian for someone who picks English every time.
          // This title's own choice first, then the profile's default.
          const wanted =
            titlePrefsRef.current.audioLanguage ||
            normalizeLanguage(settings.preferredAudioLanguage);
          const preferred =
            wanted && wanted !== "device" && wanted !== "original"
              ? tracks.audio.find(
                  (track) => normalizeLanguage(track.language) === wanted,
                )
              : undefined;
          const chosen =
            preferred ??
            tracks.audio.find((track) => track.default) ??
            tracks.audio[0];
          setSelectedAudio(chosen.ordinal);
          if (chosen.ordinal > 0) setProxyAudioOrdinal(chosen.ordinal);
        }
        // Only noted here, not started. Extraction reads the whole file over
        // the same debrid link playback is streaming from, and those links
        // limit concurrent connections - so a download nobody asked for can
        // stall the video. It waits for the subtitle menu to be opened.
        setProxyHasTextSubtitles(tracks.subtitles.some((track) => track.textBased));
      })
      .catch(() => {
        // Tracks are an enhancement; playback does not depend on them.
      });
    return () => abort.abort();
  }, [url]);

  useEffect(() => {
    if (proxyDuration > 0) setDuration(proxyDuration);
  }, [proxyDuration]);

  // Extraction is a pass over the file, so the list is polled until the tracks
  useEffect(() => {
    if (addonSubtitlesAsked) return;
    const abort = new AbortController();
    // An episode is addressed as its own id (tt1234:1:2); a film is just the
    // title's. An anime episode also by its IMDb mapping, which is the only
    // id most subtitle addons understand.
    void loadAddonSubtitles(meta.type, subtitleRequestIds(meta, video), addons, {
      filename: stream.behaviorHints?.filename,
      signal: abort.signal,
    })
      .then((found) => {
        if (abort.signal.aborted) return;
        setAddonSubtitles(found);
      })
      .catch(() => {
        // No addon subtitles is an ordinary outcome, not a failure.
      })
      .finally(() => {
        if (!abort.signal.aborted) setAddonSubtitlesAsked(true);
      });
    return () => abort.abort();
    // Keyed on identity, not the whole objects: a metadata refresh mid-episode
    // must not ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addonSubtitlesAsked, addons, meta.type, meta.id, meta.imdbId, video?.id, video?.imdbId, video?.imdbSeason, video?.imdbEpisode, stream.behaviorHints?.filename]);

  // report ready rather than the request being held open for it.
  useEffect(() => {
    // Extraction is the fallback, and only worth its cost once the addons have
    // been asked and come back with nothing: it demuxes the entire file over
    // the same link the video is streaming from.
    if (!url || !proxiedPlayback || !subtitlesRequested) return;
    if (!addonSubtitlesAsked || addonSubtitles.length > 0) return;
    const source = url;
    const abort = new AbortController();
    let timer = 0;
    void fetchProxySubtitles(source, { extract: true, signal: abort.signal }).catch(
      () => [],
    );
    // Extraction is one pass over the whole file, and the file is remote: a
    // 56-minute episode measured at 7.5 minutes. A fixed short poll gave up
    // long before that and the subtitles simply never appeared. Polling backs
    // off rather than hammering, and waits about as long as the job can take.
    const startedAt = Date.now();
    const BUDGET_MS = 20 * 60 * 1000;
    const poll = async () => {
      const tracks = await fetchProxySubtitles(source, { signal: abort.signal }).catch(
        () => [] as ProxySubtitleTrack[],
      );
      if (abort.signal.aborted) return;
      const ready = tracks.filter((track) => track.textBased && track.ready);
      if (ready.length) setProxySubtitles(ready);
      const pending = tracks.some((track) => track.textBased && !track.ready);
      setSubtitlesPending(pending);
      const elapsed = Date.now() - startedAt;
      if (pending && elapsed < BUDGET_MS) {
        const delay = elapsed < 30_000 ? 2000 : elapsed < 180_000 ? 5000 : 15_000;
        timer = window.setTimeout(() => void poll(), delay);
      }
    };
    void poll();
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [url, proxiedPlayback, subtitlesRequested, addonSubtitlesAsked, addonSubtitles.length]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const list = element.textTracks;
    const sync = () => {
      setSubtitleTracks(
        Array.from({ length: list.length }, (_, index) => ({
          id: index,
          label: list[index].label || list[index].language || `Subtitle ${index + 1}`,
        })),
      );
      // Deliberately does not read the selection back off the element. A
      // reload disables every track for a moment, and treating that as "the
      // viewer turned subtitles off" is what made them switch themselves off
      // on every skip. The choice is owned here and re-applied on load.
      let showing = -1;
      for (let index = 0; index < list.length; index += 1) {
        if (list[index].mode === "showing") showing = index;
      }
      if (showing >= 0 && showing !== selectedSubtitleRef.current) {
        setSelectedSubtitle(showing);
      }
    };
    sync();
    list.addEventListener("addtrack", sync);
    list.addEventListener("removetrack", sync);
    list.addEventListener("change", sync);
    return () => {
      list.removeEventListener("addtrack", sync);
      list.removeEventListener("removetrack", sync);
      list.removeEventListener("change", sync);
    };
  }, [url, proxySubtitles]);

  /**
   * The mounted text tracks, described rather than just labelled: the picker
   * groups by language and says where each one came from, so two Russian
   * tracks from different sources are told apart. Built from the same arrays
   * in the same order they are mounted in, rather than by parsing labels back
   * out of the element.
   */
  const subtitleOptions = useMemo(() => {
    const fromAddons = addonSubtitles.map((track) => ({
      language: track.lang,
      source: track.addonName,
      // Nothing worth reading: an addon's id is a number from its own
      // database, and naming it told nobody anything about the subtitle.
      detail: "",
    }));
    const fromFile = proxySubtitles.map((track) => ({
      language: track.language,
      source: "Embedded",
      detail: track.title || `Track ${track.ordinal + 1}`,
    }));
    return [...fromAddons, ...fromFile].map((option, index) => ({
      ...option,
      index,
      languageLabel: languageName(option.language),
    }));
  }, [addonSubtitles, proxySubtitles]);

  /** Languages down one column, with how many sources each has. */
  const subtitleLanguages = useMemo(
    () =>
      [...new Set(subtitleOptions.map((option) => option.languageLabel))]
        .sort((left, right) => left.localeCompare(right))
        .map((label) => ({ label })),
    [subtitleOptions],
  );

  const [subtitleLanguageFilter, setSubtitleLanguageFilter] = useState<string | null>(
    null,
  );
  const shownSubtitleOptions = useMemo(
    () =>
      subtitleLanguageFilter
        ? subtitleOptions.filter(
            (option) => option.languageLabel === subtitleLanguageFilter,
          )
        : subtitleOptions,
    [subtitleOptions, subtitleLanguageFilter],
  );

  /** Audio the same way: language on top, codec and channels beneath. */
  const audioOptions = useMemo(() => {
    if (proxyAudio.length) {
      return proxyAudio.map((track) => ({
        id: track.ordinal,
        main: [languageName(track.language), track.title].filter(Boolean).join(" · "),
        sub: audioDetail(track),
      }));
    }
    return audioTracks.map((track) => ({ id: track.id, main: track.label, sub: "" }));
  }, [proxyAudio, audioTracks]);

  /**
   * The subtitle style controls. Stepped rather than free-entry: these are
   * adjusted while watching, against the picture, and a nudge is what is
   * wanted. Each writes through to the account so it holds for next time.
   */
  const SUBTITLE_COLOURS = [
    "#FFFFFFFF",
    "#FFF2E9C6",
    "#FFFFE082",
    "#FF9AD5FF",
    "#FF9AFFB0",
    "#FFCCCCCC",
  ];

  const stepColour = (direction: number) => {
    if (!onPlayerSetting) return;
    const current = SUBTITLE_COLOURS.indexOf(settings.subtitleTextColor);
    const next =
      (((current < 0 ? 0 : current) + direction) % SUBTITLE_COLOURS.length +
        SUBTITLE_COLOURS.length) %
      SUBTITLE_COLOURS.length;
    onPlayerSetting("subtitle_text_color", "string", SUBTITLE_COLOURS[next]);
  };

  /**
   * One row per adjustment: a value with a minus and a plus either side, which
   * is the shape the TV player uses and the only one that works the same under
   * a pointer and a remote.
   */
  const subtitleStyleRows = useMemo(() => {
    const setting = (key: string, type: "int" | "boolean" | "string", value: unknown) =>
      onPlayerSetting?.(key, type, value as never);
    const clampInt = (value: number, min: number, max: number) =>
      Math.min(max, Math.max(min, value));
    return [
      {
        id: "delay",
        label: "Delay",
        value: `${subtitleDelayMs >= 0 ? "+" : "−"}${Math.abs(subtitleDelayMs / 1000).toFixed(3)}s`,
        down: () => setSubtitleDelayMs((value) => value - 100),
        up: () => setSubtitleDelayMs((value) => value + 100),
      },
      {
        // One action, so one button: a minus and a plus either side of it
        // would suggest two directions it does not have.
        id: "reset-delay",
        label: subtitleDelayMs === 0 ? "Delay in sync" : "Reset Delay",
        action: () => setSubtitleDelayMs(0),
        disabled: subtitleDelayMs === 0,
      },
      {
        // Kept against this title rather than written to the profile: sizing
        // subtitles up for one transfer should not resize everything else.
        // The profile's own default is set in Settings.
        id: "font-size",
        label: "Font Size",
        value: `${subtitleFontSizeSp}px`,
        down: () => setTitleFontSizeSp(clampInt(subtitleFontSizeSp - 1, 6, 40)),
        up: () => setTitleFontSizeSp(clampInt(subtitleFontSizeSp + 1, 6, 40)),
      },
      {
        id: "position",
        label: "Position",
        value: `${settings.subtitleBottomOffset}px`,
        down: () =>
          setting("subtitle_bottom_offset", "int", clampInt(settings.subtitleBottomOffset - 2, -200, 600)),
        up: () =>
          setting("subtitle_bottom_offset", "int", clampInt(settings.subtitleBottomOffset + 2, -200, 600)),
      },
      {
        id: "line-spacing",
        label: "Line Spacing",
        value: `${settings.subtitleLineSpacing}px`,
        down: () =>
          setting("subtitle_line_spacing", "int", clampInt(settings.subtitleLineSpacing - 1, -12, 24)),
        up: () =>
          setting("subtitle_line_spacing", "int", clampInt(settings.subtitleLineSpacing + 1, -12, 24)),
      },
      {
        id: "bold",
        label: "Bold",
        value: settings.subtitleBold ? "On" : "Off",
        down: () => setting("subtitle_bold", "boolean", !settings.subtitleBold),
        up: () => setting("subtitle_bold", "boolean", !settings.subtitleBold),
      },
      {
        id: "outline",
        label: "Outline",
        value: settings.subtitleOutlineEnabled
          ? `${settings.subtitleOutlineWidth}px`
          : "Off",
        down: () =>
          settings.subtitleOutlineWidth <= 1
            ? setting("subtitle_outline_enabled", "boolean", false)
            : setting("subtitle_outline_width", "int", clampInt(settings.subtitleOutlineWidth - 1, 0, 10)),
        up: () => {
          if (!settings.subtitleOutlineEnabled) {
            setting("subtitle_outline_enabled", "boolean", true);
            return;
          }
          setting("subtitle_outline_width", "int", clampInt(settings.subtitleOutlineWidth + 1, 0, 10));
        },
      },
      {
        id: "text-colour",
        label: "Text Color",
        value: (settings.subtitleTextColor.replace(/^#/, "").slice(-6) || "FFFFFF").toUpperCase(),
        down: () => stepColour(-1),
        up: () => stepColour(1),
      },
    ];
    // subtitleFontSizeSp is read by the Font Size row and derived from state
    // this memo does not otherwise watch. Without it here the row's handlers
    // keep closing over the size from the render that built them, so every
    // press recomputes from the same stale base and the size moves once and
    // then sticks - and the number shown beside it never changes either.
  }, [settings, subtitleDelayMs, onPlayerSetting, subtitleFontSizeSp]);


  const subtitleStyleToggles = useMemo(
    () => [
      {
        id: "subtitle_bold",
        label: "Bold",
        value: settings.subtitleBold,
      },
      {
        id: "subtitle_outline_enabled",
        label: "Outline",
        value: settings.subtitleOutlineEnabled,
      },
    ],
    [settings],
  );

  const applySubtitleDelay = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    const shift = subtitleDelayMs / 1000;
    const list = element.textTracks;
    for (let index = 0; index < list.length; index += 1) {
      const cues = list[index].cues;
      if (!cues) continue;
      for (let position = 0; position < cues.length; position += 1) {
        const cue = cues[position];
        let original = cueOriginals.current.get(cue);
        if (!original) {
          original = { start: cue.startTime, end: cue.endTime };
          cueOriginals.current.set(cue, original);
        }
        const nextStart = Math.max(0, original.start + shift);
        const nextEnd = Math.max(nextStart + 0.001, original.end + shift);
        // Only when it actually differs. Assigning to a cue that is on screen
        // takes it out of the active list and puts it back, and this pass runs
        // on every cuechange - so rewriting the same numbers repeatedly left
        // cues stuck on screen instead of clearing at their end.
        if (
          Math.abs(cue.startTime - nextStart) < 0.001 &&
          Math.abs(cue.endTime - nextEnd) < 0.001
        ) {
          continue;
        }
        try {
          cue.startTime = nextStart;
          cue.endTime = nextEnd;
        } catch {
          // Some tracks expose read-only timings; nothing to do but leave them.
        }
      }
    }
  }, [subtitleDelayMs]);

  const applyCuePlacement = useCallback(() => {
    const element = videoRef.current;
    // The layer is moved from the stylesheet there; cues keep their own
    // placement, which is what lets simultaneous ones stack.
    if (!element || canShiftCueLayer) return;
    const offset = clamp(settings.subtitleBottomOffset, -200, 600);
    const height = element.clientHeight || 1;
    // A percentage of the video's height, so the same pixel figure holds
    // whatever size the picture is. Kept just inside the box: a line past
    // either edge is dropped by the browser rather than clipped, which reads
    // as the subtitles vanishing.
    const line = clamp(100 - (offset / height) * 100, 0, 100);
    for (let trackIndex = 0; trackIndex < element.textTracks.length; trackIndex += 1) {
      const cues = element.textTracks[trackIndex].cues;
      if (!cues) continue;
      for (let cueIndex = 0; cueIndex < cues.length; cueIndex += 1) {
        const cue = cues[cueIndex] as TextTrackCue & {
          line?: number | "auto";
          snapToLines?: boolean;
        };
        // Same reasoning as the timings: only write a value that changes.
        if (typeof cue.line !== "undefined" && cue.line !== line) {
          cue.snapToLines = false;
          cue.line = line;
        }
      }
    }
  }, [settings.subtitleBottomOffset]);

  /**
   * Cues do not exist until the browser has fetched and parsed the track it
   * was told to show, so switching subtitles produces a track whose cues turn
   * up a moment later - unstyled, at the file's own timings. Everything the
   * viewer has set is re-applied on every signal that new cues have appeared.
   */
  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const apply = () => {
      applySubtitleDelay();
      applyCuePlacement();
    };
    apply();
    const list = element.textTracks;
    list.addEventListener("change", apply);
    list.addEventListener("addtrack", apply);
    const active: TextTrack[] = [];
    for (let index = 0; index < list.length; index += 1) {
      // cuechange is the one that fires once the cues are actually parsed.
      list[index].addEventListener("cuechange", apply);
      active.push(list[index]);
    }
    // A backstop for a track that loads slowly enough to miss every event
    // above. Harmless now that a pass with nothing to change writes nothing.
    const timer = window.setInterval(apply, 2000);
    return () => {
      list.removeEventListener("change", apply);
      list.removeEventListener("addtrack", apply);
      for (const track of active) track.removeEventListener("cuechange", apply);
      window.clearInterval(timer);
    };
  }, [applySubtitleDelay, applyCuePlacement, selectedSubtitle, proxySubtitles, addonSubtitles]);

  /** So a source is only auto-subtitled once, and never over a real choice. */
  /**
   * Keep this title's corrections. Written on change rather than on close: a
   * tab shut mid-episode is exactly when a delay someone just dialled in would
   * otherwise be lost.
   */
  useEffect(() => {
    rememberForTitle({ subtitleDelayMs });
  }, [rememberForTitle, subtitleDelayMs]);
  useEffect(() => {
    if (titleFontSizeSp === null) return;
    rememberForTitle({ subtitleFontSizeSp: titleFontSizeSp });
  }, [rememberForTitle, titleFontSizeSp]);

  const subtitleAutoApplied = useRef(false);

  /**
   * Turn subtitles on by themselves once the addons have answered.
   *
   * They were loaded but left off until the picker was opened, which meant
   * opening it every time to get what the preference already said was wanted.
   * A preference of "none" is honoured, and this runs once per source so it
   * cannot come back over an explicit Off.
   */
  useEffect(() => {
    if (subtitleAutoApplied.current) return;
    if (!subtitleTracks.length || !subtitleOptions.length) return;
    if (settings.preferredSubtitleLanguage === "none" && !titlePrefs.subtitleLanguage) {
      subtitleAutoApplied.current = true;
      return;
    }
    const device = navigator.languages?.length
      ? navigator.languages
      : [navigator.language];
    // What was chosen against this title last time comes first: it is a
    // decision about this title, where the profile's preference is a default
    // for everything that has not had one made.
    const wanted = [
      titlePrefs.subtitleLanguage,
      settings.preferredSubtitleLanguage,
      settings.secondaryPreferredSubtitleLanguage,
      ...(settings.preferredSubtitleLanguage === "device" ? device : []),
    ]
      .map(normalizeLanguage)
      .filter((value) => value && value !== "device" && value !== "original");
    const match = wanted.length
      ? subtitleOptions.find((option) =>
          wanted.includes(normalizeLanguage(option.language)),
        )
      : null;
    if (!match) return;
    subtitleAutoApplied.current = true;
    selectSubtitle(match.index);
  }, [subtitleTracks, subtitleOptions, settings.preferredSubtitleLanguage, settings.secondaryPreferredSubtitleLanguage, titlePrefs.subtitleLanguage]);

  const selectSubtitle = (id: number) => {
    // Recorded as a language rather than an index: track 3 of this release is
    // a different language in the next one.
    const language = subtitleOptions.find((option) => option.index === id)?.language;
    rememberForTitle({
      subtitleLanguage: id < 0 ? undefined : normalizeLanguage(language) || undefined,
    });
    const list = videoRef.current?.textTracks;
    if (list) {
      for (let index = 0; index < list.length; index += 1) {
        list[index].mode = index === id ? "showing" : "disabled";
      }
    }
    setSelectedSubtitle(id);
    setSubtitleOpen(false);
  };

  // Mounted as real <track> elements so the browser renders and styles them
  // through the same path as any other subtitle, cue offset included.
  useEffect(() => {
    const element = videoRef.current;
    if (!element || !url) return;
    // The tracks are mounted after a wait now: an addon's subtitle file is a
    // different URL to the film and needs its own signature before the proxy
    // will relay it, and a <track> src cannot be filled in afterwards.
    let cancelled = false;
    const mounted: HTMLTrackElement[] = [];
    const add = (label: string, lang: string, src: string) => {
      if (!src) return null;
      const node = document.createElement("track");
      node.kind = "subtitles";
      node.label = label;
      node.srclang = lang && lang !== "und" ? lang : "und";
      // Left disabled: a track's cues are only fetched once it is shown, so
      // listing ten of them costs nothing until one is picked.
      node.src = src;
      element.appendChild(node);
      mounted.push(node);
      return node;
    };
    void (async () => {
      await Promise.all(
        addonSubtitles.map((track) => ensureProxySignature(track.url)),
      );
      if (cancelled) return;
      for (const track of addonSubtitles)
        add(
          `${track.lang.toUpperCase()} · ${track.addonName}`,
          track.lang,
          subtitleRelayUrl(track.url),
        );
      for (const track of proxySubtitles)
        add(
          `${trackLabel(track, track.ordinal, "Subtitle")} · Embedded`,
          track.language,
          proxySubtitleUrl(url, track.ordinal),
        );
      // Extraction finishing rebuilds this list mid-playback, and the tracks
      // that come back are new objects: every one starts disabled, so a
      // subtitle the viewer had chosen would quietly switch itself off. Put
      // the choice back on whichever track now holds that position.
      const chosen = selectedSubtitleRef.current;
      if (chosen >= 0 && chosen < mounted.length) {
        window.setTimeout(() => {
          const list = element.textTracks;
          for (let index = 0; index < list.length; index += 1) {
            list[index].mode = index === chosen ? "showing" : "disabled";
          }
        }, 50);
      }
    })();
    return () => {
      cancelled = true;
      for (const node of mounted) node.remove();
    };
  }, [url, proxySubtitles, addonSubtitles]);

  useEffect(() => {
    localStorage.setItem("nuvio-web-volume", String(volume));
    localStorage.setItem("nuvio-web-muted", String(muted));
  }, [volume, muted]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        ["INPUT", "SELECT", "TEXTAREA"].includes(
          (event.target as HTMLElement)?.tagName,
        )
      )
        return;
      if (event.key === "Escape") {
        // Only swallowed when something is actually open, so Escape still
        // leaves fullscreen the rest of the time.
        if (
          subtitleOpen ||
          audioOpen ||
          externalPlayerOpen ||
          sourcesOpen ||
          brightnessOpen
        ) {
          event.preventDefault();
          setSubtitleOpen(false);
          setAudioOpen(false);
          setExternalPlayerOpen(false);
          setSourcesOpen(false);
          setBrightnessOpen(false);
        }
        return;
      }
      if (subtitleOpen || audioOpen || externalPlayerOpen || sourcesOpen) return;
      const modified = event.ctrlKey || event.metaKey || event.altKey;
      if (modified && event.key.toLowerCase() !== "f") return;
      if (event.key === " " || event.key.toLowerCase() === "k") {
        event.preventDefault();
        togglePlayback();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const amount = event.key === "ArrowRight" ? 10 : -10;
        seekBy(amount);
        showHud({ kind: "seek", amount });
      }
      else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        // Taken from the page, which would otherwise scroll behind the film.
        event.preventDefault();
        nudgeVolume.current(event.key === "ArrowUp" ? 0.05 : -0.05);
      }
      else if (event.key.toLowerCase() === "m") muteFromKeyboard.current();
      else if (event.key.toLowerCase() === "f") {
        // Ctrl/Cmd+F would otherwise open the browser's find bar over the
        // film, so it is taken here - but only while the player is up.
        if (event.ctrlKey || event.metaKey) event.preventDefault();
        toggleFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    seekBy,
    showHud,
    toggleFullscreen,
    togglePlayback,
    brightnessOpen,
    subtitleOpen,
    audioOpen,
    externalPlayerOpen,
    sourcesOpen,
  ]);

  useEffect(() => {
    if (nativePlayer) return;
    const element = videoRef.current;
    if (!element) return;
    // Read from whichever is playing. The decoding player never touches the
    // video element, so reading the element reported a position of zero and
    // nothing was ever saved for the streams that need it most.
    const report = (ended: boolean) => {
      const engine = engineRef.current;
      // Mid-seek the element is either still on the old stream or between
      // streams, so its clock says nothing about where the viewer is. Writing
      // a checkpoint from it would save a resume point they have already left.
      if (!ended && pendingSeekReloadRef.current !== null) return;
      const position = (engine ? engine.currentTime : element.currentTime) * 1000;
      if (position > 0 || ended)
        reportRef.current(position, knownDurationMs(), ended);
    };
    // Every 15s while playing, plus the moments a position actually matters.
    const timer = window.setInterval(() => {
      const running = engineRef.current
        ? !engineRef.current.paused
        : !element.paused;
      if (running) report(false);
    }, 15_000);
    const onPause = () => report(false);
    const onEnded = () => report(true);
    // `pagehide` rather than `unload`: iOS never fires unload for a PWA being
    // backgrounded, so the last position would be lost every time.
    const onHide = () => report(element.ended);
    element.addEventListener("pause", onPause);
    element.addEventListener("ended", onEnded);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.clearInterval(timer);
      element.removeEventListener("pause", onPause);
      element.removeEventListener("ended", onEnded);
      window.removeEventListener("pagehide", onHide);
      // Closing the player is the most important report of all.
      report(engineRef.current ? false : element.ended);
    };
  }, []);

  const selectAudio = (id: number) => {
    if (proxyAudioOrdinal !== null || (proxiedPlayback && audioTracks.length > 1)) {
      // Changing track re-runs the transcode, and a transcode cannot be
      // seeked - so asking the element to jump back afterwards did nothing and
      // playback resumed from the beginning. The new stream has to be told
      // where to start, the same way a seek tells it.
      const resumeFrom = Math.max(0, Math.floor(videoRef.current?.currentTime ?? 0));
      const language = proxyAudio.find((track) => track.ordinal === id)?.language;
      if (language && normalizeLanguage(language)) {
        // The language, not the track number: ordinal 4 is a different dub in
        // the next release, so only the language is worth carrying over.
        onPlayerSetting?.("preferred_audio_language", "string", normalizeLanguage(language));
        // And against this title too, which is what decides the next episode:
        // a series watched in its original language by someone whose profile
        // says English should stay that way without being reset every time.
        rememberForTitle({ audioLanguage: normalizeLanguage(language) });
      }
      setProxyAudioOrdinal(id);
      if (resumeFrom > 0) {
        proxyStartNonce.current += 1;
        setProxyStart({
          forUrl: url ?? "",
          seconds: resumeFrom,
          nonce: proxyStartNonce.current,
        });
      }
      setSelectedAudio(id);
      setAudioOpen(false);
      return;
    }
    if (nativePlayer) {
      setSelectedAudio(id);
      setAudioOpen(false);
      void nativePlayer.setAudioTrack(id).catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "Could not select audio."),
      );
      return;
    }
    if (engineRef.current) {
      void engineRef.current.selectAudioTrack(id);
      setSelectedAudio(id);
      setAudioOpen(false);
      return;
    }
    if (hlsRef.current) hlsRef.current.audioTrack = id;
    else {
      const list = (
        videoRef.current as
          (HTMLVideoElement & { audioTracks?: NativeAudioTrackList }) | null
      )?.audioTracks;
      if (list)
        for (let index = 0; index < list.length; index += 1)
          list[index].enabled = index === id;
    }
    setSelectedAudio(id);
    setAudioOpen(false);
  };
  const openExternalPlayer = (mode: ExternalPlayerMode) => {
    if (!externalUrl) return;
    setExternalPlayerOpen(false);
    // Paused first: the handoff unmounts this player, and a video element torn
    // down mid-play can leave the remuxer fetching for a moment after.
    const element = videoRef.current;
    element?.pause();
    if (nativePlayer) void nativePlayer.stop();
    // Where it got to here, so the other player picks up mid-scene rather than
    // at the last saved checkpoint.
    onExternalPlay(
      mode,
      externalUrl,
      Math.max(0, (nativePlayer ? currentTime : element?.currentTime ?? 0) * 1000),
    );
  };
  const setPlayerVolume = (next: number) => {
    if (nativePlayer) {
      const normalized = clamp(next, 0, 1);
      setVolume(normalized);
      setMuted(normalized === 0);
      void nativePlayer.setVolume(Math.round(normalized * 100)).catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "Could not change volume."),
      );
      return;
    }
    if (engineRef.current) {
      engineRef.current.setVolume(next);
      engineRef.current.setMuted(next === 0);
      setVolume(next);
      setMuted(next === 0);
      return;
    }
    const element = videoRef.current;
    if (!element) return;
    element.volume = next;
    element.muted = next === 0;
  };
  nudgeVolume.current = (delta) => {
    keepControlsUp();
    // Turning it up out of a mute is what pressing up means, so the step
    // starts from silence rather than from the level hiding behind it.
    const from = muted ? 0 : volume;
    // Rounded, or a run of steps drifts onto values the slider cannot sit on.
    const next = clamp(Math.round((from + delta) * 100) / 100, 0, 1);
    setPlayerVolume(next);
    showHud({ kind: "volume", level: next, muted: next === 0 });
  };
  muteFromKeyboard.current = () => {
    keepControlsUp();
    toggleMuted();
    // The state it is going to, not the one it is leaving. Silenced reads as
    // an empty meter rather than the level waiting behind it, which is what
    // the slider does with a mute too.
    showHud({ kind: "volume", level: muted ? volume : 0, muted: !muted });
  };
  useEffect(() => {
    let live = true;
    setSkipSegments([]);
    void loadSkipSegments(meta.id, video?.season, video?.episode).then(
      (segments) => {
        if (live) setSkipSegments(segments);
      },
    );
    return () => {
      live = false;
    };
  }, [meta.id, video?.season, video?.episode]);
  const skippable = activeSkipSegment(skipSegments, currentTime);

  const nextEpisode = useMemo(() => {
    if (!episodes?.length || !onPlayEpisode) return null;
    const candidate = resolveNextEpisode(
      episodes,
      video?.season,
      video?.episode,
    );
    // An addon lists a whole season including episodes that do not exist yet.
    return candidate && hasEpisodeAired(candidate.released) ? candidate : null;
  }, [episodes, onPlayEpisode, video?.season, video?.episode]);
  /**
   * Hands an episode to the app to resolve a source for.
   *
   * Stopped, and said to be stopping, before the resolve starts: it takes
   * seconds, and in silence the episode you just left simply carried on.
   */
  const startEpisode = useCallback(
    (next: Video) => {
      if (switching || next.id === video?.id) return;
      if (nativePlayer) void nativePlayer.stop();
      engineRef.current?.pause();
      videoRef.current?.pause();
      setPlaying(false);
      setWaiting(true);
      setStatus("Loading episode…");
      setSwitching(true);
      setEpisodesOpen(false);
      // `switching` and the spinner are only cleared by a new source arriving,
      // so an episode that cannot be resolved used to leave the player waiting
      // on one for ever - spinner running, Next disabled, and the explanation
      // painted behind the player where it could not be read. Being told it
      // failed is what lets it put itself back.
      void Promise.resolve(onPlayEpisode?.(next)).then((started) => {
        if (started === false) {
          setSwitching(false);
          setWaiting(false);
          setStatus("");
        }
      });
    },
    [onPlayEpisode, switching, video?.id],
  );

  /**
   * Fetch the next episode's subtitles before it is asked for.
   *
   * Only the addon ones. Reading the subtitles embedded in the next episode
   * would mean resolving it through debrid and then demuxing the whole file -
   * over the same link this episode is streaming from, and those links limit
   * concurrent connections. That is the contention that made extraction
   * on-demand in the first place, and it is not worth re-introducing to save a
   * wait that addons answer in a second anyway.
   *
   * The proxy serves a relayed subtitle with a day's cache lifetime, so
   * warming the one that will actually be chosen leaves nothing to wait for.
   */
  useEffect(() => {
    if (!nextEpisode || !addons.length || currentTime <= 0 || duration <= 0) return;
    if (currentTime / duration < 0.85) return;
    const abort = new AbortController();
    void loadAddonSubtitles(meta.type, subtitleRequestIds(meta, nextEpisode), addons, {
      signal: abort.signal,
    })
      .then((found) => {
        if (abort.signal.aborted || !found.length) return;
        const wanted = normalizeLanguage(settings.preferredSubtitleLanguage);
        const match =
          found.find((track) => normalizeLanguage(track.lang) === wanted) ?? found[0];
        void prepareSubtitleRelay(match.url).then((relay) => {
          if (relay && !abort.signal.aborted)
            void fetch(relay, { signal: abort.signal }).catch(() => {});
        });
      })
      .catch(() => {
        // A warm cache is a convenience; failing to warm it costs nothing.
      });
    return () => abort.abort();
    // Deliberately keyed on the episode rather than the clock: this must run
    // once as the end approaches, not on every timeupdate.
  }, [nextEpisode?.id, currentTime > 0 && duration > 0 && currentTime / duration >= 0.85]);

  /**
   * Say what is coming next as soon as this episode is actually playing, so
   * the work of finding it happens now rather than when the button is pressed.
   *
   * Not held back until the credits, the way the subtitle warm-up above is:
   * the Next button sits on the control bar for the whole episode, so waiting
   * would leave every early press as slow as it was. The shell decides what to
   * keep and for how long; asking twice for the same episode costs nothing.
   */
  useEffect(() => {
    if (!nextEpisode || currentTime <= 0) return;
    prepareRef.current?.(nextEpisode);
    // Keyed on the episode and on playback having started, not on the clock:
    // this must run once, not on every timeupdate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextEpisode?.id, currentTime > 0]);

  /**
   * The other sources for what is playing, fetched only when asked for: this
   * is several addon requests, and most viewings never change source.
   */
  const openSources = useCallback(() => {
    setAudioOpen(false);
    setSubtitleOpen(false);
    setExternalPlayerOpen(false);
    setSourcesOpen((open) => !open);
    if (sourceList.length || sourcesLoading || !addons.length) return;
    setSourcesLoading(true);
    void loadStreams(meta.type, video?.id || meta.id, addons)
      .then(async (found) => {
        // The same list the sources sheet shows, by the same rules: 4K is not
        // offered in the browser, and a torrent Torbox does not hold cannot be
        // streamed at all - offering it here was offering a dead end, and it
        // is what made this list disagree with the one the source was picked
        // from. Ordering was already shared.
        const offered = sortStreams(found.filter(offeredInBrowser));
        if (!settings.debridEnabled) return offered;
        const held = await checkDebridCached(offered, providerCredentials).catch(
          () => null,
        );
        // Unanswered is not the same as none: an unchecked list shows
        // everything rather than hiding what it merely could not confirm.
        if (!held) return offered;
        return offered.filter(
          (item) =>
            !needsDebridResolve(item) ||
            held[String(item.infoHash || "").toLowerCase()],
        );
      })
      .then(setSourceList)
      .catch(() => setSourceList([]))
      .finally(() => setSourcesLoading(false));
  }, [
    addons,
    meta.type,
    meta.id,
    video?.id,
    sourceList.length,
    sourcesLoading,
    settings.debridEnabled,
    providerCredentials,
  ]);

  /**
   * Named from its parsed attributes when the resolver will handle it, so the
   * addon's release blob stays out of the heading - the same rule the sources
   * sheet uses. The release itself is printed underneath instead.
   */
  const sourceLabel = useCallback(
    (item: Stream) =>
      streamLabel(
        item,
        settings.debridEnabled && needsDebridResolve(item) ? DEBRID_SHORT_NAME : null,
      ),
    [settings.debridEnabled],
  );
  const sourceRelease = useCallback(
    (item: Stream) => {
      const release = streamReleaseName(item);
      return release && release !== sourceLabel(item) ? release : null;
    },
    [sourceLabel],
  );

  const chooseSource = useCallback(
    (next: Stream) => {
      setSourcesOpen(false);
      // Report where playback got to first: the new source starts from the
      // saved position, and without this it would resume from whenever
      // progress last happened to be written rather than from here.
      const element = videoRef.current;
      const position = (element?.currentTime ?? 0) * 1000;
      if (position > 0) onProgress(position, knownDurationMs(), false);
      onSelectStream?.(next);
    },
    [knownDurationMs, onProgress, onSelectStream],
  );

  const closePlayer = useCallback(() => {
    if (nativePlayer) {
      const snapshot = nativeProgressSnapshotRef.current;
      if (snapshot.positionMs > 0 || snapshot.ended) {
        onNativeProgressSnapshot?.(
          snapshot.positionMs,
          snapshot.durationMs,
          snapshot.ended,
        );
      }
      void nativePlayer.stop();
    }
    onClose();
  }, [onClose, onNativeProgressSnapshot]);
  const showNextEpisode =
    !!nextEpisode &&
    !nextDismissed &&
    !error &&
    shouldShowNextEpisode(
      currentTime * 1000,
      duration * 1000,
      undefined,
      creditsStart(skipSegments),
    );

  const seekLimit = duration || 0;
  const displayedTime = seekPreview ?? currentTime;
  /**
   * `deliberate` marks an interaction that means to seek - releasing the
   * pointer on the bar, or a key. Those commit whatever the input reads, since
   * a click that happens to land on the current value fires no change event at
   * all, leaving nothing in the ref and the seek silently dropped. Blur is not
   * deliberate: it fires when focus merely moves away.
   */
  const commitSeekPreview = (fallback: number, deliberate = false) => {
    const target = seekPreviewRef.current ?? fallback;
    if (seekPreviewRef.current === null && !deliberate) return;
    seekPreviewRef.current = null;
    void seekTo(target);
  };

  return (
    <div
      ref={playerRef}
      className={`player-view${nativePlayer ? " native-player" : ""}${nativePlayer && !nativeSurfaceReady ? " native-player-loading" : ""} ${controlsVisible || error ? "controls-visible" : "controls-hidden"}`}
      onPointerMove={showControls}
      onPointerDown={showControls}
    >
      <style>{cueCss}</style>
      <video
        ref={videoRef}
        playsInline
        autoPlay
        preload="auto"
        // A cross-origin <track> will not load at all without this: the cue
        // file is fetched under the element's CORS mode, and unset means "no
        // CORS", which fails every subtitle served from the proxy. Only set
        // where playback is already going through the proxy, since it also
        // applies to the media request - a direct source that sends no CORS
        // headers would stop playing.
        crossOrigin={proxiedPlayback ? "anonymous" : undefined}
        poster={video?.thumbnail || meta.background}
        style={{
          objectFit: videoFit,
          // Left alone at its default: a filter of any kind puts the video on
          // its own composited layer, which is not worth doing to multiply by
          // one.
          filter: brightness === 1 ? undefined : `brightness(${brightness})`,
          display: nativePlayer || decoding ? "none" : undefined,
        }}
        onDoubleClick={toggleFullscreen}
      />
      {/* Where the decoder draws. Object-fit matches the video element so the
          two look the same whichever is playing. */}
      <canvas
        ref={canvasRef}
        className="player-canvas"
        style={{
          objectFit: videoFit,
          filter: brightness === 1 ? undefined : `brightness(${brightness})`,
          display: !nativePlayer && decoding ? undefined : "none",
        }}
        onDoubleClick={toggleFullscreen}
      />
      <div className="player-shade player-shade-top" />
      <div className="player-shade player-shade-bottom" />
      <div className="player-top">
        <button className="circle-button" aria-label="Back" onClick={closePlayer}>
          <ArrowLeft />
        </button>
        <div>
          <small>
            {video?.season
              ? `Season ${video.season} · Episode ${video.episode}`
              : meta.type}
            {settings.showParentalGuide && meta.ageRating
              ? ` · ${meta.ageRating}`
              : ""}
          </small>
          <strong>{video?.title || meta.name}</strong>
        </div>
        {endsAt && (
          <span className="player-ends-at" title="Estimated finish time">
            Ends at {endsAt}
          </span>
        )}
      </div>
      {/* The shell's notice lives in the page, which this covers entirely, so
          anything raised while the player is open - a source that would not
          resolve, an episode with nothing playable - was painted behind it.
          Shown here instead, above the controls and the dialogs. */}
      {notice && (
        <div className="player-notice" role="status">
          <span>{notice}</span>
          {onDismissNotice && (
            <button
              className="player-notice-dismiss"
              aria-label="Dismiss"
              onClick={onDismissNotice}
            >
              <X size={16} />
            </button>
          )}
        </div>
      )}
      {/* What a shortcut key just did. The player answers a keypress here
          rather than by raising the whole control bar, which covered the
          scene to report a change of ten seconds. */}
      {hud && (
        <div className="player-hud" key={hud.at} role="status" aria-live="polite">
          {hud.kind === "seek" ? (
            <>
              {hud.amount < 0 ? <Rewind /> : <FastForward />}
              <span className="player-hud-value">
                {hud.amount > 0 ? "+" : hud.amount < 0 ? "−" : ""}
                {Math.abs(hud.amount)}s
              </span>
              {/* Where it landed: the one thing the hidden bar would have
                  been read for. */}
              <span className="player-hud-detail">
                {formatTime(displayedTime)}
              </span>
            </>
          ) : (
            <>
              {hud.muted ? <VolumeX /> : <Volume2 />}
              <span className="player-hud-value">
                {Math.round(hud.level * 100)}%
              </span>
              <span className="player-hud-meter">
                <span style={{ width: `${hud.level * 100}%` }} />
              </span>
            </>
          )}
        </div>
      )}
      {!error && waiting && settings.showLoadingOverlay && (
        <div className="player-center player-center-busy" aria-label="Loading">
          <LoaderCircle className="spin" />
        </div>
      )}
      {!error && !waiting && !playing && (
        <button className="player-center" aria-label="Play" onClick={togglePlayback}>
          <Play />
        </button>
      )}
      {status && !waiting && !error && (
        <div className="player-status">{status}</div>
      )}
      {warning && !error && (
        <div className="player-warning" role="status">
          <span>{warning}</span>
          {externalUrl && (
            <button
              className="warning-action"
              onClick={() => platform.externalPlayer.copyUrl(externalUrl)}
            >
              <Copy size={15} /> Copy stream URL
            </button>
          )}
          <button
            className="notice-dismiss"
            aria-label="Dismiss"
            onClick={() => setWarning("")}
          >
            <X size={18} />
          </button>
        </div>
      )}
      {sourcesOpen && (
        <div className="track-dialog track-dialog-side">
          <div className="track-dialog-title">Sources</div>
          <div className="track-rail track-rail-cards">
            {sourcesLoading && <p className="subtitle-note">Fetching sources…</p>}
            {!sourcesLoading && !sourceList.length && (
              <p className="subtitle-note">No other sources were returned.</p>
            )}
            {sourceList.map((item, index) => {
              const current =
                (item.url && item.url === stream.url) ||
                (!!item.infoHash && item.infoHash === stream.infoHash);
              return (
                <button
                  key={`${item.addonName}:${index}`}
                  className={`track-item track-item-card${current ? " selected" : ""}`}
                  onClick={() => (current ? setSourcesOpen(false) : chooseSource(item))}
                >
                  <span className="track-item-main">{sourceLabel(item)}</span>
                  <span className="track-item-sub">
                    {[
                      current ? "Playing" : null,
                      streamQuality(item),
                      readableFileSize(streamSizeBytes(item) ?? undefined),
                      streamSeeders(item) !== null ? `${streamSeeders(item)} seeders` : null,
                      item.addonName,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {sourceRelease(item) && (
                    <span className="track-item-sub track-item-release">
                      {sourceRelease(item)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {(subtitleOpen || audioOpen || sourcesOpen) && (
        <div
          className="track-backdrop"
          onClick={() => {
            setSubtitleOpen(false);
            setAudioOpen(false);
            setSourcesOpen(false);
          }}
        />
      )}
      {/* Rendered at the player's root, not beside the button that opens
          it: as a screen over the film it has to size against the player,
          and .player-controls is a stacking context it cannot escape. */}
      {subtitleOpen && (
        <div className="subtitle-screen">
          <div className="subtitle-screen-title">Subtitles</div>
          <div className="subtitle-screen-grid">
            <div className="subtitle-rail">
              <button
                className={`subtitle-language${subtitleLanguageFilter === null ? " selected" : ""}`}
                onClick={() => setSubtitleLanguageFilter(null)}
              >
                <span>All</span>
              </button>
              {subtitleLanguages.map((language) => (
                <button
                  key={language.label}
                  className={`subtitle-language${subtitleLanguageFilter === language.label ? " selected" : ""}`}
                  onClick={() => setSubtitleLanguageFilter(language.label)}
                >
                  <span>{language.label}</span>
                </button>
              ))}
            </div>

            {/* Above the track list rather than below it: the list is as long
                as the addons make it, and these are the adjustments a viewer
                reaches for while watching - buried under fifty subtitle
                options they looked like they did not exist. */}
            {onPlayerSetting && (
              <div className="subtitle-rail subtitle-rail-style">
                {subtitleStyleRows.map((row) =>
                  "action" in row ? (
                    <button
                      key={row.id}
                      className="subtitle-style-action"
                      disabled={row.disabled}
                      onClick={row.action}
                    >
                      {row.label}
                    </button>
                  ) : (
                    <div key={row.id} className="subtitle-style-row">
                      <button aria-label={`${row.label} down`} onClick={row.down}>
                        −
                      </button>
                      <span className="subtitle-style-value">
                        <span className="subtitle-style-label">{row.label}</span>
                        <span className="subtitle-style-reading">{row.value}</span>
                      </span>
                      <button aria-label={`${row.label} up`} onClick={row.up}>
                        +
                      </button>
                    </div>
                  ),
                )}
              </div>
            )}

            <div className="subtitle-rail">
              <button
                className={`subtitle-option${selectedSubtitle === -1 ? " selected" : ""}`}
                onClick={() => selectSubtitle(-1)}
              >
                <span className="subtitle-option-language">None</span>
              </button>
              {shownSubtitleOptions.map((option) => (
                <button
                  key={option.index}
                  className={`subtitle-option${selectedSubtitle === option.index ? " selected" : ""}`}
                  onClick={() => selectSubtitle(option.index)}
                >
                  <span className="subtitle-option-source">{option.source}</span>
                  <span className="subtitle-option-language">
                    {option.languageLabel}
                  </span>
                  {option.detail && (
                    <span className="subtitle-option-detail">
                      {option.detail}
                    </span>
                  )}
                  {selectedSubtitle === option.index && (
                    <span className="subtitle-option-check">✓</span>
                  )}
                </button>
              ))}
              {!addonSubtitlesAsked && subtitleOptions.length === 0 && (
                <p className="subtitle-note">Asking your addons…</p>
              )}
              {subtitlesPending && (
                <p className="subtitle-note">
                  No addon had subtitles for this, so they are being read out of
                  the file itself. That takes a few minutes on a feature; they
                  appear here as they finish.
                </p>
              )}
              {addonSubtitlesAsked &&
                !subtitlesPending &&
                subtitleOptions.length === 0 && (
                  <p className="subtitle-note">Nothing found for this one.</p>
                )}
            </div>
          </div>
        </div>
      )}
      {audioOpen && (
        <div className="track-dialog">
          <div className="track-dialog-title">Audio</div>
          {audioOptions.length ? (
            <div className="track-rail">
              {audioOptions.map((track) => (
                <button
                  key={track.id}
                  className={`track-item${selectedAudio === track.id ? " selected" : ""}`}
                  onClick={() => selectAudio(track.id)}
                >
                  <span className="track-item-main">{track.main}</span>
                  {track.sub && (
                    <span className="track-item-sub">{track.sub}</span>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <p>The browser reports only the default track.</p>
          )}
          {riskyAudio && (
            <small>
              This source advertises an audio/container format that
              browsers may not decode. Use an external player if it
              stays silent.
            </small>
          )}
          {!nativePlayer && navigableExternalUrl && (
            <a href={navigableExternalUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink /> Open externally
            </a>
          )}
        </div>
      )}
      <div className="player-controls">
        <div className="player-timeline">
          <span>{formatTime(displayedTime)}</span>
          <input
            aria-label="Seek"
            type="range"
            min="0"
            max={seekLimit}
            step="0.1"
            value={Math.min(displayedTime, seekLimit)}
            onChange={(event) => {
              const target = Number(event.target.value);
              seekPreviewRef.current = target;
              setSeekPreview(target);
            }}
            onPointerUp={(event) =>
              commitSeekPreview(Number(event.currentTarget.value), true)
            }
            onKeyUp={(event) => {
              if (
                event.key.startsWith("Arrow") ||
                event.key === "Home" ||
                event.key === "End"
              )
                commitSeekPreview(Number(event.currentTarget.value), true);
            }}
            onBlur={(event) => {
              commitSeekPreview(Number(event.currentTarget.value));
            }}
            style={
              {
                "--played": `${seekLimit ? (displayedTime / seekLimit) * 100 : 0}%`,
              } as CSSProperties
            }
          />
          <span>{formatTime(duration)}</span>
        </div>
        <div className="player-control-row">
          <div className="player-control-group">
            <button
              className="player-play"
              aria-label={playing ? "Pause" : "Play"}
              onClick={togglePlayback}
            >
              {playing ? <Pause /> : <Play />}
            </button>
            {/* Only where there is one to go to — a film, or the last episode
                of a season, would leave a button that does nothing. */}
            {nextEpisode && (
              <button
                aria-label={
                  nextEpisode.season != null && nextEpisode.episode != null
                    ? `Next episode: S${nextEpisode.season} E${nextEpisode.episode}`
                    : "Next episode"
                }
                disabled={switching}
                onClick={() => startEpisode(nextEpisode)}
              >
                <SkipForward />
              </button>
            )}
            {/* Labelled rather than icon-only: which of three fittings is in
                force is not something a glyph can say, and the whole point of
                the control is knowing what the frame is currently doing. */}
            <button
              className="player-aspect"
              aria-label={`Aspect ratio: ${aspectMode}. Change`}
              title={`Aspect ratio: ${aspectMode}`}
              onClick={() => {
                showControls();
                setAspectMode((current) => {
                  // A mode reached from Settings need not be in the cycle;
                  // indexOf returning -1 then starts it at the first entry.
                  const at = ASPECT_MODES.indexOf(current);
                  return ASPECT_MODES[(at + 1) % ASPECT_MODES.length];
                });
              }}
            >
              <Ratio />
              <span>{aspectMode}</span>
            </button>
            {/* Not offered to the native player: that draws on a surface of
                its own, behind the page, where a CSS filter cannot reach it. */}
            {!nativePlayer && (
              <div className="player-brightness">
                <button
                  className={brightnessOpen ? "active" : ""}
                  aria-label={`Brightness: ${Math.round(brightness * 100)}%. Adjust`}
                  title={`Brightness: ${Math.round(brightness * 100)}%`}
                  aria-expanded={brightnessOpen}
                  onClick={() => {
                    showControls();
                    setBrightnessOpen((open) => !open);
                  }}
                >
                  <Sun />
                  {/* Only when it is doing something. A percentage sitting at
                      100 beside every other control is noise, but a picture
                      that has been lifted should say so. */}
                  {brightness !== 1 && (
                    <span>{Math.round(brightness * 100)}%</span>
                  )}
                </button>
                {brightnessOpen && (
                  <div className="player-brightness-panel">
                    <input
                      className="volume-slider"
                      aria-label="Brightness"
                      type="range"
                      // Lifting only, which is what a dark grade needs. Going
                      // the other way would dim the subtitles with the
                      // picture: cues are drawn inside the video element, so
                      // the filter reaches them too - and at anything above
                      // one, white stays white.
                      min="1"
                      max="2"
                      step="0.05"
                      value={brightness}
                      onChange={(event) => {
                        showControls();
                        setBrightness(Number(event.target.value));
                      }}
                      style={
                        {
                          // The bar fills from the left of its own range, so
                          // untouched reads as empty rather than as half full.
                          "--played": `${(brightness - 1) * 100}%`,
                        } as CSSProperties
                      }
                    />
                    <button
                      className="player-brightness-reset"
                      disabled={brightness === 1}
                      onClick={() => {
                        showControls();
                        setBrightness(1);
                      }}
                    >
                      Reset
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="player-control-group player-control-right">
            <button
              aria-label={muted ? "Unmute" : "Mute"}
              onClick={() => toggleMuted()}
            >
              {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
            </button>
            <input
              className="volume-slider"
              aria-label="Volume"
              type="range"
              min="0"
              max="1"
              step="0.02"
              value={muted ? 0 : volume}
              onChange={(event) => setPlayerVolume(Number(event.target.value))}
              style={
                {
                  "--played": `${muted ? 0 : volume * 100}%`,
                } as CSSProperties
              }
            />
            {/* Only where there is something to choose between: a lone track
                is already showing or already the only audio. */}
            {(subtitleTracks.length > 0 ||
              proxyHasTextSubtitles ||
              addons.length > 0) && (
              <div className="audio-picker">
                <button
                  className={subtitleOpen ? "active" : ""}
                  aria-label="Subtitles"
                  aria-expanded={subtitleOpen}
                  onClick={() => {
                    setAudioOpen(false);
                    setExternalPlayerOpen(false);
                    // Asking for subtitles is what starts the extraction pass.
                    setSubtitlesRequested(true);
                    setSubtitleOpen((value) => !value);
                  }}
                >
                  <Subtitles />
                </button>
              </div>
            )}
            {onSelectStream && !!addons.length && (
              <div className="audio-picker">
                <button
                  className={sourcesOpen ? "active" : ""}
                  aria-label="Sources"
                  aria-expanded={sourcesOpen}
                  onClick={openSources}
                >
                  <Layers />
                </button>
              </div>
            )}
            <div className="audio-picker">
              <button
                className={audioOpen ? "active" : ""}
                aria-expanded={audioOpen}
                onClick={() => {
                  setSubtitleOpen(false);
                  setExternalPlayerOpen(false);
                  setAudioOpen((value) => !value);
                }}
              >
                <Music2 />
              </button>
            </div>
            {!nativePlayer && externalUrl && !!platform.externalPlayer.options("player").length && (
              <div className="external-player-picker">
                <button
                  className={externalPlayerOpen ? "active" : ""}
                  aria-label="Open in external player"
                  aria-expanded={externalPlayerOpen}
                  onClick={() => {
                    setAudioOpen(false);
                    setExternalPlayerOpen((value) => !value);
                  }}
                >
                  <ExternalLink />
                </button>
                {externalPlayerOpen && (
                  <div className="external-player-menu">
                    <strong>Open with</strong>
                    {platform.externalPlayer.options("player").map((option) => (
                      <button
                        key={option.mode}
                        onClick={() => openExternalPlayer(option.mode)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {!!episodes?.length && onPlayEpisode && (
              <button
                aria-label="Episodes"
                className={episodesOpen ? "active" : ""}
                aria-expanded={episodesOpen}
                onClick={() => {
                  setAudioOpen(false);
                  setExternalPlayerOpen(false);
                  setEpisodesOpen((value) => !value);
                }}
              >
                <List />
              </button>
            )}
            <button aria-label="Fullscreen" onClick={toggleFullscreen}>
              <Maximize />
            </button>
          </div>
        </div>
      </div>
      {skippable && !error && (
        <button
          className="player-skip"
          onClick={() => {
            showControls();
            void seekTo(skippable.end);
          }}
        >
          <FastForward /> {skipLabel(skippable.kind)}
        </button>
      )}
      {showNextEpisode && nextEpisode && (
        <div className="player-next">
          <div>
            <small>Up next</small>
            <strong>
              {nextEpisode.season != null && nextEpisode.episode != null
                ? `S${nextEpisode.season}·E${nextEpisode.episode} `
                : ""}
              {nextEpisode.title || "Next episode"}
            </strong>
          </div>
          <button onClick={() => setNextDismissed(true)}>Not now</button>
          <button
            className="primary"
            disabled={switching}
            onClick={() => startEpisode(nextEpisode)}
          >
            <SkipForward /> Play
          </button>
        </div>
      )}
      {episodesOpen && !!episodes?.length && (
        <div
          className="player-episodes-scrim"
          onClick={() => setEpisodesOpen(false)}
        >
          {/* The detail page's own list, not a second one built to look like
              it: same rows, same watched eye, same resume bar, and the same
              season picker rather than every season run together with the
              specials among them. */}
          <aside
            className="player-episodes"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span className="eyebrow">EPISODES</span>
                <strong>{meta.name}</strong>
              </div>
              <button
                className="circle-button"
                aria-label="Close"
                onClick={() => setEpisodesOpen(false)}
              >
                <X />
              </button>
            </header>
            <label className="season-select-wrap">
              <span>SEASON</span>
              <Select
                value={season ?? ""}
                onChange={(event) => setSeason(Number(event.target.value))}
              >
                {seasons.map((value) => (
                  <option key={value} value={value}>
                    {value === 0 ? "Specials" : `Season ${value}`}
                  </option>
                ))}
              </Select>
            </label>
            <div className="episode-list-heading">
              <strong>
                {season === 0 ? "Specials" : `Season ${season ?? seasons[0] ?? 1}`}
              </strong>
              <span>
                {seasonEpisodes.length}{" "}
                {seasonEpisodes.length === 1 ? "episode" : "episodes"}
              </span>
            </div>
            <div className="player-episode-list episode-list is-detailed">
              {seasonEpisodes.map((item) => {
                const key = watchKey(meta.id, item.season, item.episode);
                return (
                  <EpisodeRow
                    key={item.id}
                    video={item}
                    watched={watchIndex?.watched.has(key) ?? false}
                    percent={watchIndex ? episodePercent(watchIndex, key) : 0}
                    remaining={watchIndex ? remainingShort(watchIndex, key) : ""}
                    blurred={false}
                    onPlay={() => startEpisode(item)}
                    onMenu={() => undefined}
                  />
                );
              })}
            </div>
          </aside>
        </div>
      )}
      {error && (
        <div className="player-error">
          <strong>Browser playback unavailable</strong>
          {/* The message is the diagnosis, and it is long. Tapping it copies
              it so it can be pasted somewhere useful rather than retyped from
              a phone screen. */}
          <p
            className="player-error-message"
            role="button"
            tabIndex={0}
            title="Tap to copy this message"
            onClick={() => {
              void navigator.clipboard.writeText(error);
              setErrorCopied(true);
              window.setTimeout(() => setErrorCopied(false), 1600);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              void navigator.clipboard.writeText(error);
              setErrorCopied(true);
              window.setTimeout(() => setErrorCopied(false), 1600);
            }}
          >
            {error}
          </p>
          <small className="player-error-hint">
            {errorCopied ? "Copied" : "Tap the message to copy it"}
          </small>
          {/* What can play it, offered where it failed. Being told the
              browser cannot decode something is only half an answer; the other
              half is the list of things that can. */}
          {!nativePlayer && externalUrl && !!platform.externalPlayer.options("player").length && (
            <div className="player-error-players">
              <small>Play it in</small>
              <div>
                {platform.externalPlayer.options("player").map((option) => (
                  <button
                    key={option.mode}
                    onClick={() => openExternalPlayer(option.mode)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            {!nativePlayer && externalUrl && (
              <>
                {navigableExternalUrl && (
                  <a href={navigableExternalUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink /> Open stream
                  </a>
                )}
                <button
                  onClick={() => navigator.clipboard.writeText(externalUrl)}
                >
                  <Copy /> Copy URL
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
