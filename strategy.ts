// Pump.fun launch sniper — Family A ("early spike rider"), hand-written for
// "Pump.fun Bot Sprint: Make Bot And Win" (agent-fun/replay/v2).
//
// Thesis, from the dev tape (24h of pump.fun, Nov 2-3 2026): a new coin's whole
// run-up happens in its first ~2 slots — by the time any bot's buy can fill
// (2-slot latency) the price is already ~1.4x launch and the median remaining
// upside is ~6%. Nearly everything then dies. So the only edge is (a) buy the
// first spike, but only on coins whose opening trade was SMALL (a big first buy
// means the creator already pumped it and dumps next), (b) require the price to
// have real momentum already (>=1.2x launch), and (c) get out fast: take profit
// at +80%, fold weak coins after ~60 slots, trail the rare runner.
//
// Entry: at the 2nd trade, when real SOL reserves are >= 1 SOL (so a 0.01+ SOL
// buy fits the 1%-of-reserve cap), first trade a buy of < 1 SOL, price 1.2x-2x
// launch. Size 0.02 SOL, one shot per mint, max 5 open positions.
// Exit: full take-profit at 1.8x entry; hard stop at -20%; trailing stop that
// sells on a 25% giveback from the peak (active from entry); fold at age 60
// slots when below 1.05x entry; time exit at 400 slots.
//
// Everything is a pure function of the batch stream: no clock, no env, no
// randomness. Deterministic by construction.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- parameters

/** Enter once this many trades have been seen on the mint. */
const ENTRY_TRADE = 2;
/** Minimum price multiple vs launch at entry (require real momentum). */
const MIN_ENTRY_MULT = 1.2;
/** Maximum price multiple vs launch at entry (do not chase a spike). */
const MAX_ENTRY_MULT = 2.0;
/** The first trade must be a buy no bigger than this (else the creator pumped it). */
const MAX_FIRST_BUY_LAMPORTS = 1_000_000_000n; // 1 SOL
/** Do not enter a mint older than this (slots after its CreateEvent). */
const MAX_AGE_SLOTS = 120;
/** Buy size per coin. */
const BUY_SIZE_LAMPORTS = 20_000_000n; // 0.02 SOL
/** Smallest buy worth sending (guardrail: round trips need >= 0.01 SOL buys). */
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL
/** Slippage tolerance on entries (bps). */
const BUY_SLIPPAGE_BPS = 2000;
/** Slippage tolerance on exits (bps). */
const SELL_SLIPPAGE_BPS = 2000;
/** Full take-profit: sell everything at this multiple of entry price. */
const TAKE_PROFIT_MULT = 1.8;
/** Hard stop: sell at this much below entry price. */
const HARD_STOP = 0.2;
/** Trailing stop starts once the peak reaches this multiple of entry. */
const TRAIL_TRIGGER_MULT = 1.0;
/** Trailing stop: sell when the price gives back this share of the peak. */
const TRAIL_GIVEBACK = 0.25;
/** Fold weak coins: at this age (slots) sell when below FOLD_MULT of entry. */
const FOLD_AGE_SLOTS = 60;
const FOLD_MULT = 1.05;
/** Time exit: sell whatever is left at this age (slots). */
const MAX_HOLD_SLOTS = 400;

// ---------------------------------------------------------------- per-mint state

interface MintTrack {
  createdSlot: number;
  launchPrice: number;
  trades: number;
  /** Lamports of the first trade, when it was a buy; null otherwise. */
  firstBuyLamports: bigint | null;
  complete: boolean;
}

interface PeakInfo {
  peakMult: number;
  entrySlot: number;
}

/** A launch sniper with a take-profit, a trailing stop and an early fold. */
export class SniperStrategy {
  readonly #tracks = new Map<Pubkey, MintTrack>();
  /** Mints with a buy sent and not yet resolved into an exit. */
  readonly #entered = new Set<Pubkey>();
  /** Mints fully exited (one shot each: never re-enter). */
  readonly #done = new Set<Pubkey>();
  /** Mints that failed the entry filter (never retry). */
  readonly #rejected = new Set<Pubkey>();
  /** Peak multiple and entry slot per open position. */
  readonly #peak = new Map<Pubkey, PeakInfo>();

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    this.#applyFills(state, batch);
    this.#applyEvents(batch);
    const orders: OrderInput[] = [];
    this.#addExits(state, orders);
    this.#addEntries(state, batch, orders);
    return orders;
  }

  // --- fills: a rejected/failed buy frees its mint for a retry; a sell that
  // empties a position (or a harness close) retires the mint for good.
  #applyFills(state: BotState, batch: Batch): void {
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        if (f.side === 'sell') {
          this.#done.add(f.mint);
          this.#entered.delete(f.mint);
          this.#peak.delete(f.mint);
        }
        continue;
      }
      if (f.side === 'buy') {
        if (f.status === 'filled') {
          this.#peak.set(f.mint, { peakMult: 1, entrySlot: f.slot });
        } else {
          this.#entered.delete(f.mint);
        }
      } else if (f.side === 'sell' && f.status === 'filled' && !state.positions.has(f.mint)) {
        this.#done.add(f.mint);
        this.#entered.delete(f.mint);
        this.#peak.delete(f.mint);
      }
    }
  }

  // --- track each mint's first trade and completion from the batch's events.
  #applyEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        this.#tracks.set(e.mint, {
          createdSlot: e.slot,
          launchPrice: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          trades: 0,
          firstBuyLamports: null,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const t = this.#tracks.get(e.mint);
        if (t === undefined) continue;
        t.trades += 1;
        if (t.trades === 1 && e.is_buy) t.firstBuyLamports = BigInt(e.sol_amount);
      } else {
        const t = this.#tracks.get(e.mint);
        if (t !== undefined) t.complete = true;
      }
    }
  }

  // --- exits for every open position.
  #addExits(state: BotState, orders: OrderInput[]): void {
    for (const [mint, pos] of state.positions) {
      // A sell for this mint is already in flight (fills land 2 slots after
      // the decision, while the position still shows here): sending another
      // full-size sell for the same tokens can only resolve as
      // insufficient_tokens once the first fill lands, and burns an order
      // slot entries could use. Wait for it to resolve instead — a rejected
      // sell leaves `pending` in the same batch its fill arrives, so the
      // retry is re-issued in this very batch, with no delay. Only skip when
      // the pending sell covers the whole holding, so a partial fill still
      // gets its remainder sold.
      let sellPending = false;
      for (const p of state.pending.values()) {
        if (p.order.side === 'sell' && p.order.mint === mint && BigInt(p.order.token_amount) >= pos.token_amount) {
          sellPending = true;
          break;
        }
      }
      if (sellPending) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
      const entryPrice = Number(pos.cost_lamports) / Number(pos.token_amount);
      if (!(entryPrice > 0) || !(price > 0)) continue;
      const mult = price / entryPrice;
      let info = this.#peak.get(mint);
      if (info === undefined) {
        info = { peakMult: 1, entrySlot: state.slot };
        this.#peak.set(mint, info);
      }
      if (mult > info.peakMult) info.peakMult = mult;
      const age = state.slot - info.entrySlot;
      let sell = false;
      if (mult >= TAKE_PROFIT_MULT) sell = true;
      if (mult <= 1 - HARD_STOP) sell = true;
      if (info.peakMult >= TRAIL_TRIGGER_MULT && mult <= info.peakMult * (1 - TRAIL_GIVEBACK)) sell = true;
      if (age >= FOLD_AGE_SLOTS && mult < FOLD_MULT) sell = true;
      if (age >= MAX_HOLD_SLOTS) sell = true;
      if (sell) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      }
    }
  }

  // --- entries: only mints with an event in this batch can trigger.
  #addEntries(state: BotState, batch: Batch, orders: OrderInput[]): void {
    const maxOrders = state.hello.caps.max_orders_per_batch;
    const maxOpen = state.hello.caps.max_open_positions;
    let committed = state.committedPositionCount();
    for (const e of batch.events) {
      if (e.event !== 'CreateEvent' && e.event !== 'TradeEvent') continue;
      const mint = e.mint;
      if (this.#done.has(mint) || this.#rejected.has(mint) || this.#entered.has(mint)) continue;
      if (state.positions.has(mint)) continue;
      const t = this.#tracks.get(mint);
      if (t === undefined || t.complete) continue;
      if (state.slot - t.createdSlot > MAX_AGE_SLOTS) {
        this.#rejected.add(mint);
        continue;
      }
      if (t.trades < ENTRY_TRADE) continue;
      if (t.firstBuyLamports === null || t.firstBuyLamports > MAX_FIRST_BUY_LAMPORTS) {
        this.#rejected.add(mint);
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
      const mult = price / t.launchPrice;
      if (mult > MAX_ENTRY_MULT) {
        this.#rejected.add(mint);
        continue;
      }
      if (mult < MIN_ENTRY_MULT) continue; // wait for momentum; ages out above
      const cap = state.maxBuyLamports(mint);
      const size = cap < BUY_SIZE_LAMPORTS ? cap : BUY_SIZE_LAMPORTS;
      if (size < MIN_BUY_LAMPORTS) continue; // reserve too small yet; wait
      if (committed >= maxOpen) continue;
      if (orders.length >= maxOrders) break;
      orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
      this.#entered.add(mint);
      committed += 1;
    }
  }
}
