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

export type HotelComparisonRow = Record<string, string | number>;

export type HotelComparisonFeature =
  | "price"
  | "roomType"
  | "amenities"
  | "distance";
