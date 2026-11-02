"use client";

import { useLayoutEffect, useState } from "react";
import { DICTS, type Lang } from "@/lib/i18n";
import styles from "./video-embed.module.css";

/**
 * A thumbnail with a play button that becomes the YouTube player on click. The player
 * (and YouTube's cookies) load only when someone actually wants to watch.
 */
export function VideoEmbed({ lang, videoId, start, title }: { lang: Lang; videoId: string; start: number; title: string }) {
  const [playing, setPlaying] = useState(false);
  const [thumb, setThumb] = useState(`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`);
  const fallback = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

  // Next keeps a page you've left alive but hidden (React <Activity>), so a playing video
  // would go on playing, heard but not seen. This cleanup runs as the page is hidden and
  // swaps the player back to the thumbnail, which removes the iframe and stops the sound.
  useLayoutEffect(() => () => setPlaying(false), []);

  if (playing) {
    return (
      <div className={styles.frame}>
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${videoId}?start=${Math.floor(start)}&autoplay=1&rel=0`}
          title={title}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
        />
      </div>
    );
  }
  return (
    <button className={styles.frame} onClick={() => setPlaying(true)} aria-label={DICTS[lang].watchFromDish(title)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={thumb}
        alt=""
        onError={() => setThumb(fallback)}
        onLoad={(e) => e.currentTarget.naturalWidth <= 120 && setThumb(fallback)}
      />
      <span className={styles.play} aria-hidden>▶</span>
    </button>
  );
}
