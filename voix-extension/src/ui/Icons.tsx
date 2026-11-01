import type { ReactNode } from "react";

function Svg({ size = 22, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

const stroke = { stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const SkipBackIcon = () => (
  <Svg>
    <rect x="5" y="5.5" width="2.4" height="13" rx="1.2" fill="currentColor" />
    <path d="M19 6.6v10.8a1 1 0 0 1-1.55.83L9.6 13.03a1.2 1.2 0 0 1 0-2.06l7.85-5.2A1 1 0 0 1 19 6.6z" fill="currentColor" />
  </Svg>
);

export const SkipForwardIcon = () => (
  <Svg>
    <rect x="16.6" y="5.5" width="2.4" height="13" rx="1.2" fill="currentColor" />
    <path d="M5 6.6v10.8a1 1 0 0 0 1.55.83l7.85-5.2a1.2 1.2 0 0 0 0-2.06l-7.85-5.2A1 1 0 0 0 5 6.6z" fill="currentColor" />
  </Svg>
);

export const PlayIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M8 5.7v12.6a1 1 0 0 0 1.53.85l9.9-6.3a1 1 0 0 0 0-1.7l-9.9-6.3A1 1 0 0 0 8 5.7z" fill="currentColor" />
  </Svg>
);

export const PauseIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <rect x="6.5" y="5" width="4" height="14" rx="1.3" fill="currentColor" />
    <rect x="13.5" y="5" width="4" height="14" rx="1.3" fill="currentColor" />
  </Svg>
);

export const StopIcon = () => (
  <Svg size={20}>
    <rect x="6" y="6" width="12" height="12" rx="2.6" fill="currentColor" />
  </Svg>
);

export const MinusIcon = () => (
  <Svg>
    <path d="M6 12h12" {...stroke} />
  </Svg>
);

export const PlusIcon = () => (
  <Svg>
    <path d="M12 6v12M6 12h12" {...stroke} />
  </Svg>
);

export const CloseIcon = () => (
  <Svg>
    <path d="M7 7l10 10M17 7L7 17" {...stroke} />
  </Svg>
);

export const ChevronDownIcon = () => (
  <Svg>
    <path d="M6.5 9.5L12 15l5.5-5.5" {...stroke} />
  </Svg>
);

export const ChevronUpIcon = () => (
  <Svg>
    <path d="M6.5 14.5L12 9l5.5 5.5" {...stroke} />
  </Svg>
);

export const InfoIcon = () => (
  <Svg size={20}>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
    <path d="M12 11v5.5" {...stroke} strokeWidth={2} />
    <circle cx="12" cy="7.8" r="1.2" fill="currentColor" />
  </Svg>
);

/** The Voix mark. White V on deep sky blue (the only white-on-blue allowed: it's the logo). */
export function VoixLogo({ size = 32 }: { size?: number }) {
  const small = size <= 32;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="voix-logo">
      <rect width="32" height="32" rx={small ? 8 : 9} fill="#00BFFF" />
      <path
        d={small ? "M8 9L16 24L24 9" : "M8.5 9.5L16 23.5L23.5 9.5"}
        stroke="#FFFFFF"
        strokeWidth={small ? 4 : 3.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
