import { z } from "zod";
import {
  ConversationNode,
  Tool,
  type ConversationNodeRunResult,
  type ConversationToolResult,
  type GraphNodeUpdate,
  type ToolDefinition,
} from "@picoflow/ezgraph";
import { parseUtcDate, quoteNow, yearsBetween } from "../backend/quote-clock.js";
import type {
  DriverProfile,
  QuoteGraphStateType,
} from "../quote-graph.state.js";
import {
  endChatInstruction,
  fillPrompt,
  quotePrompt,
} from "../prompt/quote-prompt.js";
import { VehicleNode } from "./vehicle.node.js";

type DriverInput = {
  fullName: string;
  dateOfBirth: string;
  licenseState: string;
  licenseStatus: "valid" | "permit" | "suspended";
  yearsLicensed: number;
};

type DriverContext = { driver?: DriverProfile };

const US_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL",
  "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
  "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH",
  "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
]);

/** First stage: identifies and validates the primary driver. */
export class DriverNode extends ConversationNode<
  QuoteGraphStateType,
  { driver?: DriverProfile },
  DriverContext
> {
  getPrompt(): string {
    return `${quotePrompt.role}\n\n${fillPrompt(quotePrompt.driver, {
      CURRENT_DATE: quoteNow().toISOString().slice(0, 10),
    })}\n\n${endChatInstruction}`;
  }

  defineTool(): readonly ToolDefinition<DriverInput>[] {
    return [
      {
        name: "capture_driver",
        description:
          "Capture the primary driver's identity and license details.",
        schema: z.object({
          fullName: z.string().min(2),
          dateOfBirth: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
          licenseState: z.string().length(2),
          licenseStatus: z.enum(["valid", "permit", "suspended"]),
          yearsLicensed: z.number().int().min(0),
        }),
      },
    ];
  }

  @Tool("capture_driver")
  async captureDriver(
    input: DriverInput,
    context: DriverContext,
  ): Promise<ConversationToolResult> {
    const licenseState = input.licenseState.toUpperCase();
    if (!US_STATE_CODES.has(licenseState)) {
      return reject(`'${input.licenseState}' is not a U.S. state code.`);
    }
    if (input.licenseStatus === "suspended") {
      return reject(
        "We cannot offer a quote while the driver's license is suspended.",
      );
    }
    const birthDate = parseUtcDate(input.dateOfBirth);
    if (!birthDate) {
      return reject("dateOfBirth must be a real calendar date in YYYY-MM-DD form.");
    }
    const now = quoteNow();
    if (birthDate > now) return reject("The date of birth cannot be in the future.");
    const age = yearsBetween(birthDate, now);
    if (age < 16) return reject("The primary driver must be at least 16 years old.");
    if (age > 100) {
      return reject("Check the date of birth; the driver's age exceeds 100.");
    }
    if (input.yearsLicensed > age - 15) {
      return reject(
        `${input.yearsLicensed} licensed years is inconsistent with a ${age}-year-old driver.`,
      );
    }
    context.driver = {
      fullName: input.fullName.trim(),
      dateOfBirth: input.dateOfBirth,
      licenseState,
      licenseStatus: input.licenseStatus,
      yearsLicensed: input.yearsLicensed,
    };
    return {
      output: { accepted: true, driver: context.driver },
      stopAfterBatch: true,
    };
  }

  protected createContext(): DriverContext {
    return {};
  }

  protected nextStep(
    _state: QuoteGraphStateType,
    context: DriverContext,
    conversation: ConversationNodeRunResult,
  ): GraphNodeUpdate<QuoteGraphStateType> {
    if (conversation.quitRequested) return this.quit(conversation);
    if (context.driver) {
      return this.advance(VehicleNode, conversation).withState({
        driver: context.driver,
      });
    }
    return this.stay(conversation);
  }
}

function reject(error: string): ConversationToolResult {
  return { output: { accepted: false, error } };
}
