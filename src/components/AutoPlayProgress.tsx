import { ArrowLeft } from "lucide-react";
import { t } from "../lib/i18n.ts";

export type AutoPlayStage = "finding" | "choosing";

/** A quiet wait over the title's artwork while the existing autoplay rules run. */
export function AutoPlayProgress({
  background,
  onManual,
  onClose,
}: {
  background?: string;
  onManual(): void;
  onClose(): void;
}) {
  return (
    <div className="autoplay-progress">
      {background && (
        <img
          key={background}
          className="autoplay-backdrop"
          src={background}
          alt=""
          onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
        />
      )}
      <div className="autoplay-content">
        <p role="status" aria-live="polite">
          <i className="mini-spinner" aria-hidden="true" />
          <span>{t("autoplay.finding")}</span>
        </p>
        <button type="button" className="autoplay-manual" onClick={onManual}>
          {t("autoplay.manual")}
        </button>
      </div>
      <button
        type="button"
        className="circle-button autoplay-close"
        aria-label={t("sources.back")}
        onClick={onClose}
      >
        <ArrowLeft />
      </button>
    </div>
  );
}
