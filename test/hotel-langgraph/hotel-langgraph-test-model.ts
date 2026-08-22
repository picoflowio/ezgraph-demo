import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type {
  HotelBoundModel,
  HotelModelFactory,
} from "../../src/graphs/hotel-langgraph/hotel-langgraph.js";

export const twoBedCriteria = {
  currentDate: "2027-07-15T00:00:00.000Z",
  amenities: ["freeWiFi", "freeParking"],
  roomType: ["one bed", "two beds", "suite"],
  cAmenities: ["freeWiFi", "freeParking"],
  cRoomType: ["two beds"],
  cPriceRange: { min: null, max: 700 },
  cDistance: { cityCenter: null, airport: null },
  cDate: { start: "2027-08-01", end: "2027-08-08" },
  cDateArray: [
    "2027-08-01",
    "2027-08-02",
    "2027-08-03",
    "2027-08-04",
    "2027-08-05",
    "2027-08-06",
    "2027-08-07",
    "2027-08-08",
  ],
  hotelFound: [],
};

const suiteCriteria = {
  ...twoBedCriteria,
  cRoomType: ["suite"],
};

export const threeHotels = [
  "Hampton Inn Portland-Airport",
  "Hampton Inn Portland/Clackamas",
  "Hampton Inn Sherwood Portland",
];

export const hotelTestModelFactory: HotelModelFactory = (stage, tools) => {
  const toolNames = new Set(tools.map(({ name }) => name));
  const model: HotelBoundModel = {
    async invoke(messages) {
      const input = latestHumanText(messages);
      if (/\b(?:quit|exit|stop conversation)\b/i.test(input)) {
        return toolCall("end", "terminate_session", {});
      }
      if (stage === "explore" && toolNames.has("capture_choices")) {
        return exploreResponse(input);
      }
      if (stage === "present" && toolNames.has("chosen_hotel")) {
        return presentResponse(input);
      }
      if (stage === "compare" && toolNames.has("generate_comparison")) {
        return compareResponse(input);
      }
      throw new Error(`Unexpected HotelLanggraph stage '${stage}'.`);
    },
  };
  return model;
};

function exploreResponse(input: string): AIMessage {
  if (/^Hi$/i.test(input)) {
    return new AIMessage(
      "I can help book Hilton hotels in the Portland, Oregon metropolitan area. Are you looking to book there?",
    );
  }
  if (/^yes$/i.test(input)) {
    return new AIMessage(
      "What date range would you like? Check-in must be after today and checkout after check-in.",
    );
  }
  if (/8\/1\/2027/i.test(input)) {
    return new AIMessage("What nightly price range or maximum budget would you like?");
  }
  if (/max 700/i.test(input)) {
    return new AIMessage("Which room type: one bed, two beds, or suite?");
  }
  if (/^suite$/i.test(input)) {
    return new AIMessage("Which amenities would you like?");
  }
  if (/wifi/i.test(input)) {
    return new AIMessage(
      "Do you care about distance to the airport or Portland city center?",
    );
  }
  if (/^none$/i.test(input)) {
    return new AIMessage(
      "Your criteria are ready. Would you like to search or make changes?",
    );
  }
  const criteria = /two|2 bed/i.test(input) ? twoBedCriteria : suiteCriteria;
  return toolCall("capture", "capture_choices", {
    json: JSON.stringify(criteria),
  });
}

function presentResponse(input: string): AIMessage {
  if (/change.*(?:two|2 bed)/i.test(input)) {
    return toolCall("search-again", "search_again", { isSearch: true });
  }
  if (/compare/i.test(input)) {
    const selected = /2\s*,?\s*5(?!.*8)/i.test(input)
      ? threeHotels.slice(0, 2)
      : threeHotels;
    return toolCall("go-compare", "go_compare", {
      hotelsToCompare: selected,
    });
  }
  if (input.trim() === "8") {
    return toolCall("book", "chosen_hotel", {
      hotelName: "Hampton Inn Sherwood Portland",
    });
  }
  return new AIMessage(
    "Here are your numbered hotel choices with total prices. You can book, change the search, or compare hotel features.",
  );
}

function compareResponse(input: string): AIMessage {
  if (/resume booking/i.test(input)) {
    return toolCall("resume", "resume_booking", { isResumed: true });
  }
  const feature = /amenit/i.test(input) ? "amenities" : "price";
  const selected = /2\s*,?\s*5(?!.*8)/i.test(input)
    ? threeHotels.slice(0, 2)
    : threeHotels;
  return toolCall("compare", "generate_comparison", {
    hotels: selected,
    feature,
  });
}

function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: [{ id, name, args, type: "tool_call" }],
  });
}

function latestHumanText(messages: readonly BaseMessage[]): string {
  const message = [...messages]
    .reverse()
    .find((candidate) => HumanMessage.isInstance(candidate));
  return message && typeof message.content === "string" ? message.content : "";
}
