import { useState } from "react";
import { posterCandidates } from "./posterUrl.js";

function PosterPlaceholder({ className = "" }) {
  return (
    <div
      className={`poster poster-placeholder${className ? ` ${className}` : ""}`}
      aria-hidden="true"
    >
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="m21 15-5-5L5 21" />
      </svg>
    </div>
  );
}

export default function ScreeningPoster({
  movie,
  verifiedArtworkUrl,
  className = "",
}) {
  const [failedUrls, setFailedUrls] = useState(() => new Set());
  const candidates = posterCandidates(movie, verifiedArtworkUrl);
  const url = candidates.find((candidate) => !failedUrls.has(candidate));

  if (!url) {
    return <PosterPlaceholder className={className} />;
  }

  return (
    <img
      className={`poster${className ? ` ${className}` : ""}`}
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => {
        setFailedUrls((current) => {
          const next = new Set(current);
          next.add(url);
          return next;
        });
      }}
    />
  );
}
