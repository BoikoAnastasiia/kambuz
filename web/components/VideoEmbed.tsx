"use client";

import { useState } from "react";
import styles from "./video-embed.module.css";

/**
 * A thumbnail with a play button that becomes the YouTube player on click. The player
 * (and YouTube's cookies) load only when someone actually wants to watch.
 */
export function VideoEmbed({ videoId, start, title }: { videoId: string; start: number; title: string }) {
  const [playing, setPlaying] = useState(false);
  const [thumb, setThumb] = useState(`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`);
  const fallback = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

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
    <button className={styles.frame} onClick={() => setPlaying(true)} aria-label={`Смотреть «${title}» с начала этого блюда`}>
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
