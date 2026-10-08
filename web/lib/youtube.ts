/**
 * The video id from a single-video YouTube link (watch?v=, youtu.be/, shorts/, live/),
 * or null. Playlists are refused on purpose: one paste should cost one video's worth.
 */
export function videoIdFrom(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, "");
  const id = /^[A-Za-z0-9_-]{11}$/;
  if (host === "youtu.be") {
    const v = url.pathname.slice(1).split("/")[0];
    return id.test(v) ? v : null;
  }
  if (host !== "youtube.com") return null;
  if (url.pathname === "/watch") {
    const v = url.searchParams.get("v") ?? "";
    return id.test(v) ? v : null;
  }
  const m = /^\/(shorts|live|embed)\/([^/?]+)/.exec(url.pathname);
  return m && id.test(m[2]) ? m[2] : null;
}

/** The canonical link the worker is given, whatever form was pasted. */
export function watchUrl(videoId: string, startSeconds?: number): string {
  const t = startSeconds && startSeconds > 0 ? `&t=${Math.floor(startSeconds)}s` : "";
  return `https://www.youtube.com/watch?v=${videoId}${t}`;
}
