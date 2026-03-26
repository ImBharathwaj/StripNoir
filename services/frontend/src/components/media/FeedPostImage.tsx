"use client";

import { useState } from "react";
import {
  getAssetDimensions,
  orientationFromDimensions,
  type FeedOrientation
} from "../../lib/feedMediaOrientation";

export default function FeedPostImage({
  src,
  alt,
  asset
}: {
  src: string;
  alt: string;
  asset: Record<string, unknown>;
}) {
  const { w, h } = getAssetDimensions(asset);
  const initial = orientationFromDimensions(w, h);
  const [orient, setOrient] = useState<FeedOrientation>(initial);

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      onLoad={(e) => {
        const img = e.currentTarget;
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          setOrient(orientationFromDimensions(img.naturalWidth, img.naturalHeight));
        }
      }}
      className={
        orient === "landscape"
          ? "block w-full h-auto max-h-[85vh] rounded-lg object-contain bg-black/25"
          : "block w-full h-auto max-h-[min(92vh,920px)] rounded-lg object-contain bg-black/25"
      }
    />
  );
}
