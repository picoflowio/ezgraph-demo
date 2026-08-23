import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type {
  QuoteBoundModel,
  QuoteModelFactory,
} from "../../src/graphs/quote-langgraph/quote-langgraph.js";

export const jamie = {
  fullName: "Jamie Rivera",
  dateOfBirth: "1993-04-12",
  licenseState: "OR",
  licenseStatus: "valid" as const,
  yearsLicensed: 10,
};

export const camrySeUse = {
  vehicleId: "2019-toyota-camry-se",
  ownership: "finance" as const,
  annualMileage: 12000,
  parking: "driveway" as const,
};

export const jamieHistory = {
  currentlyInsured: true,
  coverageLapse: false,
  incidents: [{ type: "violation" as const, date: "2026-03" }],
};

/** Plays the customer-facing model for the whole quote conversation. */
export const quoteTestModelFactory: QuoteModelFactory = (stage, tools) => {
  const toolNames = new Set(tools.map(({ name }) => name));
  const model: QuoteBoundModel = {
    async invoke(messages) {
      const input = latestHumanText(messages);
      const lastTool = latestToolOutput(messages);
      if (/\b(?:quit|exit|stop conversation)\b/i.test(input)) {
        return toolCall("end", "terminate_session", {});
      }
      if (stage === "driver" && toolNames.has("capture_driver")) {
        return driverResponse(input, lastTool);
      }
      if (stage === "vehicle" && toolNames.has("resolve_vehicle")) {
        return vehicleResponse(input, lastTool);
      }
      if (stage === "history" && toolNames.has("capture_history")) {
        return historyResponse(input);
      }
      if (stage === "coverage" && toolNames.has("select_coverage")) {
        return coverageResponse(input, lastTool);
      }
      if (stage === "quote" && toolNames.has("accept_quote")) {
        return quoteResponse(input);
      }
      throw new Error(`Unexpected QuoteLanggraph stage '${stage}'.`);
    },
  };
  return model;
};

function driverResponse(
  input: string,
  lastTool: Record<string, unknown> | undefined,
): AIMessage {
  if (lastTool?.accepted === false) {
    return new AIMessage(
      `I'm sorry — ${String(lastTool.error)} Let me know if anything changes.`,
    );
  }
  if (/suspended/i.test(input)) {
    return toolCall("driver-suspended", "capture_driver", {
      fullName: "Casey Morgan",
      dateOfBirth: "1990-01-15",
      licenseState: "OR",
      licenseStatus: "suspended",
      yearsLicensed: 8,
    });
  }
  if (/oregon/i.test(input)) {
    return toolCall("driver", "capture_driver", jamie);
  }
  return new AIMessage(
    "Welcome to Sequoia Auto Insurance. May I have your full name and date of birth?",
  );
}

function vehicleResponse(
  input: string,
  lastTool: Record<string, unknown> | undefined,
): AIMessage {
  if (lastTool?.needsTrim) {
    return new AIMessage(
      "That Camry comes in LE, SE, and XSE trims — which one is yours?",
    );
  }
  if (lastTool?.accepted === true && lastTool.vehicle) {
    return toolCall("use", "capture_vehicle_use", {
      ...camrySeUse,
      vehicleId: (lastTool.vehicle as { id: string }).id,
    });
  }
  if (/\bSE\b/.test(input)) {
    return toolCall("resolve-trim", "resolve_vehicle", {
      year: 2019,
      make: "Toyota",
      model: "Camry",
      trim: "SE",
    });
  }
  if (/camry/i.test(input)) {
    return toolCall("resolve", "resolve_vehicle", {
      year: 2019,
      make: "Toyota",
      model: "Camry",
    });
  }
  return new AIMessage(
    "What vehicle will we be insuring? Year, make, and model, please.",
  );
}

function historyResponse(input: string): AIMessage {
  if (/ticket/i.test(input)) {
    return toolCall("history", "capture_history", jamieHistory);
  }
  return new AIMessage(
    "Are you currently insured, and have you had any accidents, tickets, or claims in the last five years?",
  );
}

function coverageResponse(
  input: string,
  lastTool: Record<string, unknown> | undefined,
): AIMessage {
  if (lastTool?.accepted === false) {
    return new AIMessage(
      `We can't do that: ${String(lastTool.error)} What deductibles would you like?`,
    );
  }
  if (/liability only/i.test(input)) {
    return toolCall("coverage-bad", "select_coverage", {
      liability: "standard",
      collisionDeductible: null,
      comprehensiveDeductible: null,
      extras: [],
      startDate: "2027-06-15",
    });
  }
  if (/500/.test(input)) {
    return toolCall("coverage", "select_coverage", {
      liability: "standard",
      collisionDeductible: 500,
      comprehensiveDeductible: 500,
      extras: ["rental"],
      startDate: "2027-06-15",
    });
  }
  return new AIMessage(
    "Let's pick coverage: liability level, deductibles, extras, and a start date.",
  );
}

function quoteResponse(input: string): AIMessage {
  if (/accept/i.test(input)) {
    return toolCall("accept", "accept_quote", { tier: "selected" });
  }
  if (/rework|start over/i.test(input)) {
    return toolCall("revise", "revise_coverage", { isRevise: true });
  }
  if (/1000|1,000/.test(input)) {
    return toolCall("adjust", "adjust_quote", {
      collisionDeductible: 1000,
      comprehensiveDeductible: 1000,
    });
  }
  return new AIMessage(
    "Here are your quote options — Saver, Your selection, and Shield. Which would you like?",
  );
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

function latestToolOutput(
  messages: readonly BaseMessage[],
): Record<string, unknown> | undefined {
  const last = messages.at(-1);
  if (!last || !ToolMessage.isInstance(last)) return undefined;
  try {
    const parsed = JSON.parse(String(last.content)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
