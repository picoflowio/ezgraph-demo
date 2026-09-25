import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HotelCriteriaSnapshot } from '../../src/graphs/decision-hotel-graph/criteria-helper.js';
import { searchHotels } from '../../src/graphs/decision-hotel-graph/data/hotel-search.js';

test('hotel search uses the full JSON catalog and returns grounded hotel details', () => {
  const criteria: HotelCriteriaSnapshot = {
    dates: { answered: true, start: '2027-08-03', end: '2027-08-09' },
    budget: { answered: true, min: null, max: null },
    roomType: { answered: true, roomType: 'suite' },
    amenities: { answered: true, amenities: [] },
    distance: { answered: true, airport: null, cityCenter: null },
  };

  const hotels = searchHotels(criteria);

  assert.ok(hotels.length > 4, 'Expected the JSON catalog to return more than four suite hotels');
  assert.ok(hotels.some((hotel) => hotel.hotelName === 'Hampton Inn Sherwood Portland'));
  assert.ok(hotels.every((hotel) => hotel.address.length > 0));
  assert.ok(hotels.every((hotel) => hotel.prices.length === 7));
  assert.ok(hotels.every((hotel) => hotel.total > 0));
});
