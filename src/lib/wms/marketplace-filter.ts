export interface MarketplaceFilterOption {
  value: string;
  label: string;
}

const MARKETPLACE_FILTER_OPTIONS: readonly MarketplaceFilterOption[] = [
  { value: "", label: "Todos marketplaces" },
  { value: "Mercado Livre", label: "Mercado Livre" },
  { value: "Shopee", label: "Shopee" },
  { value: "TikTok", label: "TikTok Shop" },
];

export function getMarketplaceFilterOptions(): readonly MarketplaceFilterOption[] {
  return MARKETPLACE_FILTER_OPTIONS;
}
