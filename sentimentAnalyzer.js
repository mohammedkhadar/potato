/**
 * SentimentAnalyzer
 *
 * Uses Claude to:
 *  1. Score each article's sentiment per coin (-1 to +1)
 *  2. Aggregate scores across all articles
 *  3. Return a ranked list of trade opportunities
 */

import Anthropic from '@anthropic-ai/sdk';
import { SUPPORTED_COINS } from './newsFetcher.js';

const BATCH_SIZE = 15; // articles per Claude call to stay within context

export class SentimentAnalyzer {
  constructor({ anthropicKey }) {
    if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY is required');
    this.client = new Anthropic({ apiKey: anthropicKey });
  }

  /**
   * Analyse articles and return coin sentiment scores.
   * @returns {Array<{coin, score, confidence, reasoning, articleCount}>}
   */
  async analyze(articles) {
    if (articles.length === 0) return [];

    // Split into batches to avoid context limits
    const batches = [];
    for (let i = 0; i < articles.length; i += BATCH_SIZE) {
      batches.push(articles.slice(i, i + BATCH_SIZE));
    }

    const allScores = {}; // coin -> { total, count, reasons }

    for (const batch of batches) {
      const batchScores = await this._analyzeBatch(batch);
      for (const { coin, score, confidence, reasoning } of batchScores) {
        if (!allScores[coin]) allScores[coin] = { total: 0, weightedTotal: 0, count: 0, reasons: [] };
        allScores[coin].total += score;
        allScores[coin].weightedTotal += score * confidence;
        allScores[coin].count++;
        allScores[coin].reasons.push(reasoning);
      }
    }

    // Build ranked result
    const results = Object.entries(allScores)
      .map(([coin, data]) => ({
        coin,
        score: data.weightedTotal / data.count,       // confidence-weighted average
        rawScore: data.total / data.count,
        confidence: Math.min(data.count / 3, 1),      // more articles = more confident
        articleCount: data.count,
        reasoning: data.reasons.slice(0, 3).join(' | '),
      }))
      .filter(r => Math.abs(r.score) > 0.1)           // ignore noise
      .sort((a, b) => b.score - a.score);             // highest positive first

    console.log(`[Sentiment] Scored ${results.length} coins from ${articles.length} articles`);
    return results;
  }

  async _analyzeBatch(articles) {
    const articlesText = articles.map((a, i) =>
      `[${i + 1}] SOURCE:${a.source} | ${a.title}\n${a.body || ''}`
    ).join('\n\n');

    const prompt = `You are a crypto trading sentiment analyst. Analyze the following ${articles.length} news articles/posts and return sentiment scores.

SUPPORTED COINS: ${SUPPORTED_COINS.join(', ')}

For each coin that is meaningfully referenced in the articles, provide:
- A sentiment SCORE from -1.0 (very bearish) to +1.0 (very bullish)
- A CONFIDENCE from 0.1 to 1.0 based on how clear and credible the signal is
- Brief REASONING (max 20 words)

Focus on signals that could drive price movement in the NEXT 15 MINUTES:
- Breaking news, exchange listings, major partnerships, regulatory news
- Whale activity, large liquidations, short squeezes
- Hacks, exploits, project failures
- Viral social momentum

Ignore: vague speculation, old news, minor updates unlikely to move price

ARTICLES:
${articlesText}

Respond ONLY with valid JSON array, no other text:
[
  {"coin": "BTC", "score": 0.8, "confidence": 0.9, "reasoning": "Spot ETF approval rumored by SEC"},
  {"coin": "ETH", "score": -0.3, "confidence": 0.6, "reasoning": "Large ETH transfer to exchange signals sell pressure"}
]

If no coins have meaningful signals, return: []`;

    try {
      const message = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      });

      const raw = message.content[0].text.trim();
      const cleaned = raw.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      // Validate and sanitize
      return parsed
        .filter(r => SUPPORTED_COINS.includes(r.coin))
        .map(r => ({
          coin: r.coin,
          score: Math.max(-1, Math.min(1, Number(r.score) || 0)),
          confidence: Math.max(0.1, Math.min(1, Number(r.confidence) || 0.5)),
          reasoning: String(r.reasoning || '').slice(0, 100),
        }));
    } catch (err) {
      console.error('[Sentiment] Claude parse error:', err.message);
      return [];
    }
  }
}
