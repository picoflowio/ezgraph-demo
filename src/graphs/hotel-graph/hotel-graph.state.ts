import { createGraphStateAnnotation } from "ezgraph";
import type { NodeStateValue } from "ezgraph";
import { ExploreNode } from "./nodes/explore.node.js";

export type HotelSearchCriteria = {
  currentDate: string | null;
  amenities: string[];
  roomType: string[];
  cAmenities: string[];
  cRoomType: string[];
  cPriceRange: { min: number | null; max: number | null };
  cDistance: { cityCenter: number | null; airport: number | null };
  cDate: { start: string | null; end: string | null };
  cDateArray: string[];
  hotelFound: HotelSearchResult[];
};

export type HotelSearchResult = {
  hotelName: string;
  prices: number[];
  total: number;
};

export type HotelGraphNodes = {
  ExploreNode?: NodeStateValue<{ criteria?: HotelSearchCriteria }>;
  PresentNode?: NodeStateValue<{
    hotelFound?: HotelSearchResult[];
    hotel?: string;
    confirmationNumber?: number;
  }>;
  CompareNode?: NodeStateValue<{
    availableHotels?: string[];
    selectedHotels?: string[];
    lastComparison?: Record<string, string | number>[];
  }>;
};

export const HotelGraphState = createGraphStateAnnotation(
  ExploreNode.name,
  () => ({} as HotelGraphNodes),
);

export type HotelGraphStateType = typeof HotelGraphState.State;
