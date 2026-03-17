// Design tokens for the app
export const colors = {
  // Backgrounds
  bg: "#0a0f1a",
  bgCard: "#141c2e",
  bgCardHover: "#1a2540",
  bgElevated: "#1e293b",
  bgOverlay: "rgba(0, 0, 0, 0.7)",

  // Borders
  border: "#1e293b",
  borderLight: "#2a3650",
  borderAccent: "#334155",

  // Text
  textPrimary: "#f1f5f9",
  textLight: "#e2e8f0",
  textSemi: "#cbd5e1",
  textSecondary: "#94a3b8",
  textMuted: "#64748b",
  textDim: "#475569",

  // Accent
  accent: "#3b82f6",
  accentLight: "#60a5fa",
  accentPale: "#93c5fd",
  accentDim: "#1e3a5f",
  accentGlow: "rgba(59, 130, 246, 0.15)",

  // Status
  success: "#4ade80",
  successDark: "#16a34a",
  successBg: "#052e16",
  warning: "#fbbf24",
  warningBg: "#422006",
  orange: "#fb923c",
  orangeBg: "#431407",
  yellow: "#facc15",
  error: "#f87171",
  errorLight: "#fca5a5",
  errorBg: "#450a0a",
  info: "#60a5fa",
  infoBg: "#172554",
  neutral: "#a8a29e",
  neutralBg: "#292524",
  neutralBgDark: "#1c1917",

  // Common
  white: "#ffffff",

  // Gradients (for placeholder covers)
  gradients: [
    ["#1a1a2e", "#16213e", "#0f3460"],
    ["#1a1423", "#2d1b3d", "#1b2838"],
    ["#0f2027", "#203a43", "#2c5364"],
    ["#1f1c2c", "#928dab", "#1f1c2c"],
    ["#0c0c1d", "#1a1a3e", "#2d2b55"],
  ] as [string, string, string][],
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 18,
  full: 999,
} as const;

export const typography = {
  title: {
    fontSize: 22,
    fontWeight: "800" as const,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 16,
    fontWeight: "700" as const,
  },
  body: {
    fontSize: 14,
    fontWeight: "600" as const,
  },
  caption: {
    fontSize: 12,
    fontWeight: "600" as const,
  },
  tiny: {
    fontSize: 10,
    fontWeight: "600" as const,
  },
} as const;

// Consistent shadow for elevated cards
export const cardShadow = {
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.25,
  shadowRadius: 12,
  elevation: 8,
} as const;

// Consistent shadow for covers
export const coverShadow = {
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 6 },
  shadowOpacity: 0.4,
  shadowRadius: 10,
  elevation: 10,
} as const;
