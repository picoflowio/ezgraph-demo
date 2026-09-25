import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import {
  ModelCatalog,
  modelExecution,
  type DecisionProviderAdapter,
  type DecisionRequest,
  type DecisionResult,
  type GraphLlmConfig,
  type LlmCallOptions,
  type LlmGatewayTool,
  type ModelResult,
} from '@picoflow/ezgraph';
import { ScriptedGateway, createTurnHarness } from '@picoflow/ezgraph/testing';
import { DecisionHotelGraph } from '../../src/graphs/decision-hotel-graph/decision-hotel-graph.js';
import type { DecisionHotelGraphStateType } from '../../src/graphs/decision-hotel-graph/decision-hotel-graph.state.js';

type ScenarioTurn = {
  label: string;
  input: string;
  activeNode: string;
  completed?: boolean;
  includes?: string;
  excludes?: string;
};

const turns: ScenarioTurn[] = [
  { label: 'keep unrelated request at router', input: 'What is the weather in Seattle?', activeNode: 'RouterDecisionNode', includes: 'I can update dates' },
  { label: 'start with dates', input: 'Hi', activeNode: 'DateRangeNode' },
  { label: 'reject impossible dates', input: '2027-02-30 to 2027-03-05', activeNode: 'DateRangeNode' },
  { label: 'reject past dates', input: '2025-08-01 to 2025-08-08', activeNode: 'DateRangeNode' },
  { label: 'accept dates', input: '2027-08-01 to 2027-08-08', activeNode: 'BudgetNode' },
  { label: 'reject inverted budget', input: 'minimum 800 and maximum 500', activeNode: 'BudgetNode' },
  { label: 'accept budget', input: 'maximum 700', activeNode: 'RoomTypeNode' },
  { label: 'accept room', input: 'suite', activeNode: 'AmenityNode' },
  { label: 'reroute date correction', input: 'Actually change my dates to 2027-08-03 through 2027-08-09', activeNode: 'AmenityNode' },
  { label: 'accept amenities', input: 'free wifi and free parking', activeNode: 'DistanceNode' },
  { label: 'reject negative distance', input: 'airport within -5 miles', activeNode: 'DistanceNode' },
  { label: 'waive distance', input: 'distance does not matter', activeNode: 'RouterDecisionNode' },
  { label: 'review criteria', input: 'show my criteria', activeNode: 'RouterDecisionNode' },
  { label: 'judge requests budget confirmation', input: 'search', activeNode: 'BudgetNode' },
  { label: 'reaffirm budget', input: 'maximum 700', activeNode: 'RouterDecisionNode' },
  { label: 'reject invented presentation', input: 'search', activeNode: 'PresentNode', excludes: 'Invented Waterfront Palace' },
  { label: 'revise to empty results', input: 'change maximum budget to 500', activeNode: 'RouterDecisionNode' },
  { label: 'report empty results', input: 'search', activeNode: 'RouterDecisionNode', includes: 'No hotels matched' },
  { label: 'revise after empty results', input: 'change maximum budget to 750', activeNode: 'RouterDecisionNode' },
  { label: 'presentation outage uses grounded fallback', input: 'search', activeNode: 'PresentNode' },
  { label: 'revise after fallback', input: 'change maximum budget to 760', activeNode: 'RouterDecisionNode' },
  { label: 'accept presentation', input: 'search', activeNode: 'PresentNode' },
  { label: 'book validated result', input: 'book hotel 1', activeNode: 'end', completed: true },
];

test('DecisionHotelGraph completes the 23-turn correction, fallback, review, and booking contract', { timeout: 30_000 }, async () => {
  process.env.HOTEL_GRAPH_CURRENT_DATE = '2026-01-15T00:00:00.000Z';
  let currentInput = '';
  let criteriaReviews = 0;
  let presentationReviews = 0;
  const gateway = new HotelGateway(() => currentInput, () => presentationReviews);
  const decisions: DecisionProviderAdapter = {
    id: 'typesafe',
    async decide(request: DecisionRequest): Promise<DecisionResult> {
      const state = request.state as Record<string, any>;
      if ('destination' in request.questions) {
        if (state.notice) throw new Error('simulated router outage during notice');
        const criteria = state.criteria as Record<string, any>;
        const unresolved = state.unresolved as string[];
        let route: string;
        let delivery = 'none';
        if (/distance does not matter/i.test(currentInput) && unresolved.length === 0) route = 'search';
        else if (/weather/i.test(currentInput)) route = 'unclear';
        else if (/show.*criteria|review/i.test(currentInput)) route = 'review';
        else if (/^search$/i.test(currentInput)) route = 'search';
        else if (/\b(exit|quit|stop)\b/i.test(currentInput)) route = 'exit';
        else {
          const requested = requestedCriterion(currentInput);
          const needsApplication = requested !== undefined && !criterionIsReflected(requested, currentInput, criteria);
          route = needsApplication ? requested : (unresolved[0] ?? 'review');
          delivery = /change my dates/i.test(currentInput)
            ? 'prompt_next'
            : needsApplication ? 'apply_request' : 'prompt_next';
        }
        return { model: 'jev-fixture', answers: { destination: choice(route, ['dates', 'budget', 'room_type', 'amenities', 'distance', 'review', 'search', 'exit', 'unclear']), request_delivery: choice(delivery, ['apply_request', 'prompt_next', 'none']) }, usage: { inputTokens: 20 } };
      }
      if ('outcome' in request.questions) {
        criteriaReviews += 1;
        if (criteriaReviews === 2) throw new Error('simulated criteria judge outage');
        const outcome = criteriaReviews === 1 ? 'budget' : 'ready';
        return { model: 'jev-fixture', answers: { outcome: choice(outcome, ['ready', 'dates', 'budget', 'room_type', 'amenities', 'distance', 'unclear']), faithful: { type: 'noul', noul: 0.99 } }, usage: { inputTokens: 30 } };
      }
      presentationReviews += 1;
      if (presentationReviews === 2) throw new Error('simulated presentation judge outage');
      const accepted = presentationReviews > 1;
      return { model: 'jev-fixture', answers: { grounded: { type: 'noul', noul: accepted ? 0.99 : 0.1 }, completeness: score(2), clarity: score(2) }, usage: { inputTokens: 30 } };
    },
  };
  const harness = createTurnHarness<DecisionHotelGraphStateType>({ graph: DecisionHotelGraph, gateway, decisions, sessionId: 'decision-hotel-contract' });
  try {
    for (const scenario of turns) {
      currentInput = scenario.input;
      const turn = await harness.send(scenario.input);
      assert.equal(turn.status, 200, `${scenario.label}: ${turn.response}`);
      assert.equal(turn.completed, scenario.completed === true, scenario.label);
      assert.equal(turn.currentNode, scenario.activeNode, scenario.label);
      if (scenario.includes) assert.match(turn.response, new RegExp(scenario.includes, 'i'));
      if (scenario.excludes) assert.doesNotMatch(turn.response, new RegExp(scenario.excludes, 'i'));
    }
    const document = await harness.document();
    assert.ok(document);
    const state = document.graph.nodes!;
    assert.deepEqual(state.DateRangeNode, { answered: true, start: '2027-08-03', end: '2027-08-09' });
    assert.deepEqual(state.BudgetNode, { answered: true, min: null, max: 760 });
    assert.deepEqual(state.RoomTypeNode, { answered: true, roomType: 'suite' });
    assert.deepEqual(state.AmenityNode, { answered: true, amenities: ['freeWiFi', 'freeParking'] });
    assert.equal(state.CriteriaReadinessDecisionNode?.accepted, true);
    assert.equal(state.PresentationDecisionNode?.accepted, true);
    assert.equal(typeof state.PresentNode?.selectedHotel, 'string');
    assert.match(String(state.PresentNode?.confirmationNumber), /^\d{6}$/);
    assert.ok((document.decisionUsage?.calls ?? 0) >= 12);
    assert.ok((document.decisions?.length ?? 0) >= (document.decisionUsage?.calls ?? 0));
    assert.ok(document.decisions?.some(({ outcome }) => outcome === 'fallback'));
    assert.ok(document.decisions?.every((entry) => !('state' in entry) && !('answers' in entry) && !('questions' in entry)));
  } finally {
    delete process.env.HOTEL_GRAPH_CURRENT_DATE;
    await harness.close();
  }
});

class HotelGateway extends ScriptedGateway {
  private callId = 0;
  constructor(private readonly input: () => string, private readonly presentations: () => number) { super(); }
  override async agent(
    systemPrompt: string,
    history: readonly BaseMessage[],
    _tools: readonly LlmGatewayTool[],
    llmConfig?: GraphLlmConfig,
    _callOptions?: LlmCallOptions,
  ): Promise<ModelResult<AIMessage>> {
    const human = latestHuman(history);
    const feedback = latestTool(history);
    const tool = (name: string, args: Record<string, unknown> = {}) => new AIMessage({ content: '', tool_calls: [{ id: `hotel-${++this.callId}`, name, args, type: 'tool_call' }] });
    let value: AIMessage;
    if (systemPrompt.includes('check-in and checkout')) {
      if (feedback) value = new AIMessage(feedback);
      else {
        const dates = [...human.matchAll(/20\d{2}-\d{2}-\d{2}/g)].map((match) => match[0]);
        value = dates.length >= 2 ? tool('capture_date_range', { start: dates[0], end: dates[1] }) : new AIMessage('What are your check-in and checkout dates?');
      }
    } else if (systemPrompt.includes('minimum and maximum hotel budget')) {
      if (feedback) value = new AIMessage(feedback);
      else if (/minimum 800.*maximum 500/i.test(human)) value = tool('capture_budget', { min: 800, max: 500 });
      else {
        const maximum = human.match(/(?:maximum|max(?:imum)? budget)\D*(\d+)/i);
        value = maximum ? tool('capture_budget', { min: null, max: Number(maximum[1]) }) : new AIMessage('What nightly budget range should I use?');
      }
    } else if (systemPrompt.includes('exactly one supported room type')) {
      value = /suite/i.test(human) ? tool('capture_room_type', { roomType: 'suite' }) : new AIMessage('Choose one bed, two beds, or suite.');
    } else if (systemPrompt.includes('collect required hotel amenities')) {
      value = /change my dates/i.test(human)
        ? new AIMessage({
            content: '',
            tool_calls: [
              { id: `hotel-${++this.callId}`, name: 'capture_amenities', args: { amenities: [] }, type: 'tool_call' },
              { id: `hotel-${++this.callId}`, name: 'reroute_request', args: {}, type: 'tool_call' },
            ],
          })
        : /free wifi.*free parking/i.test(human)
          ? tool('capture_amenities', { amenities: ['freeWiFi', 'freeParking'] })
          : new AIMessage('Which amenities do you require?');
    } else if (systemPrompt.includes('maximum distance in miles')) {
      if (feedback) value = new AIMessage(feedback);
      else if (/-5/.test(human)) value = tool('capture_distance', { airport: -5, cityCenter: null });
      else value = /does not matter/i.test(human) ? tool('capture_distance', { airport: null, cityCenter: null }) : new AIMessage('Do you have a distance limit?');
    } else if (systemPrompt.includes('Present only hotels')) {
      if (/change maximum budget/i.test(this.input())) value = tool('revise_search');
      else if (/book hotel 1/i.test(this.input())) value = tool('chosen_hotel', { hotelName: '1' });
      else {
        const draft = this.presentations() === 0
          ? '1. Invented Waterfront Palace — total $1. Book now.'
          : groundedDraft(systemPrompt);
        value = tool('publish_hotel_draft', { draft });
      }
    } else throw new Error(`No scripted hotel response for ${systemPrompt.slice(0, 100)}`);
    return { value, usage: { input_tokens: 10, output_tokens: 4, thinking_tokens: 0, tool_input_tokens: 0, cached_input_tokens: 0, total_tokens: 14 }, execution: modelExecution(llmConfig ?? ModelCatalog.model('openai:gpt-4o', { retries: 0 })) };
  }
}

function choice(selected: string, labels: string[]) {
  return { type: 'choice' as const, choice: selected, confidence: 0.99, probabilities: Object.fromEntries(labels.map((label) => [label, label === selected ? 1 : 0])) };
}
function score(value: number) {
  return { type: 'score' as const, score: value, confidence: 0.99, legend: { 0: 'low', 1: 'medium', 2: 'high' }, probabilities: { 0: 0, 1: 0, 2: 1 } };
}
function requestedCriterion(input: string): string | undefined {
  if (/date|check-in|checkout|20\d{2}-\d{2}-\d{2}/i.test(input)) return 'dates';
  if (/budget|maximum|minimum|\$\d+/i.test(input)) return 'budget';
  if (/room|one bed|two beds|suite/i.test(input)) return 'room_type';
  if (/amenit|wifi|parking|breakfast|pool|fitness/i.test(input)) return 'amenities';
  if (/distance|airport|city.?center|miles?/i.test(input)) return 'distance';
  return undefined;
}
function criterionIsReflected(field: string, input: string, criteria: Record<string, any>): boolean {
  if (field === 'dates') {
    const dates = [...input.matchAll(/20\d{2}-\d{2}-\d{2}/g)].map((match) => match[0]);
    return criteria.dates?.answered === true && dates.length >= 2 && criteria.dates.start === dates[0] && criteria.dates.end === dates[1];
  }
  if (field === 'budget') {
    const maximum = input.match(/(?:maximum|max(?:imum)? budget)\D*(\d+)/i);
    return criteria.budget?.answered === true && maximum !== null && criteria.budget.max === Number(maximum[1]);
  }
  if (field === 'room_type') return criteria.roomType?.answered === true && criteria.roomType.roomType === input.match(/\b(one bed|two beds|suite)\b/i)?.[1]?.toLowerCase();
  if (field === 'amenities') return criteria.amenities?.answered === true && (!/wifi/i.test(input) || criteria.amenities.amenities.includes('freeWiFi')) && (!/parking/i.test(input) || criteria.amenities.amenities.includes('freeParking'));
  return field === 'distance' && criteria.distance?.answered === true && /does not matter/i.test(input) && criteria.distance.airport === null && criteria.distance.cityCenter === null;
}
function latestHuman(history: readonly BaseMessage[]): string {
  const message = [...history].reverse().find((candidate) => HumanMessage.isInstance(candidate));
  return typeof message?.content === 'string' ? message.content : '';
}
function latestTool(history: readonly BaseMessage[]): string {
  const message = history.at(-1);
  const content = ToolMessage.isInstance(message) && typeof message.content === 'string' ? message.content : '';
  return content === 'OK' ? '' : content;
}
function groundedDraft(prompt: string): string {
  const match = prompt.match(/\[\{.*\}\]/s);
  const hotels = match ? JSON.parse(match[0]) as Array<{ hotelName: string; address: string; prices: number[]; total: number }> : [];
  return [
    'Here are the matching Portland hotels:',
    ...hotels.map((hotel, index) => {
      const low = Math.min(...hotel.prices);
      const high = Math.max(...hotel.prices);
      return `${index + 1}. ${hotel.hotelName} — ${hotel.address} — nightly $${low.toFixed(2)}–$${high.toFixed(2)} — total $${hotel.total.toFixed(2)}`;
    }),
    'Reply with a hotel name or number to book, or revise your criteria.',
  ].join('\n');
}
