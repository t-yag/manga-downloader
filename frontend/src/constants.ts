export const PLUGIN_LABELS: Record<string, string> = {
  cmoa: "コミックシーモア",
  booklive: "BookLive",
  momonga: "momon:GA",
  nhentai: "nHentai",
  piccoma: "ピッコマ",
  kindle: "Kindle",
  dmmbooks: "DMMブックス",
};

/** @deprecated Use PLUGIN_LABELS instead */
export const SOURCE_LABELS = PLUGIN_LABELS;

export const SOURCE_COLORS: Record<string, { bg: string; text: string }> = {
  piccoma: { bg: "#3d3311", text: "#F8D149" },
  cmoa: { bg: "#2a2a2a", text: "#FFFFFF" },
  momonga: { bg: "#3b1228", text: "#E63D96" },
  booklive: { bg: "#3b1e0e", text: "#EC662B" },
  nhentai: { bg: "#3b1219", text: "#D93E57" },
  kindle: { bg: "#1a2a42", text: "#568DD8" },
  dmmbooks: { bg: "#d0d0d0", text: "#111111" },
};

export const DEFAULT_SOURCE_COLOR = { bg: "#334155", text: "#94a3b8" };

/** Native tab screens の内側余白 (SafeArea の外側) */
export const TAB_CONTENT_PADDING = 16;
