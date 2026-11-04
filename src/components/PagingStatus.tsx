import { RefreshCw } from "lucide-react";
import { t } from "../lib/i18n.ts";

/**
 * What sits under a paging grid: a spinner while the next page loads, or —
 * when it could not be loaded — what went wrong and a way to try again.
 *
 * At the bottom, where the scroll stopped, rather than above the titles that
 * did load: an error at the top of a full grid reads as the page having
 * failed, when it is only the next page that has.
 */
export function PagingStatus({
  loading,
  failure,
  onRetry,
}: {
  loading: boolean;
  failure: string;
  onRetry(): void;
}) {
  if (failure)
    return (
      <div className="grid-more grid-more-failed" role="alert">
        <span>
          <strong>{t("catalog.moreFailed")}</strong>
          <small>{failure}</small>
        </span>
        <button type="button" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          {t("action.retry")}
        </button>
      </div>
    );
  if (loading)
    return (
      <div className="grid-more" role="status">
        <i className="mini-spinner" />
        {t("common.loadingMore")}
      </div>
    );
  return null;
}
