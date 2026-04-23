/**
 * SentimentAnalyzer
 *
 * Uses an OpenAI-compatible chat API (default: OpenRouter + two OSS models) to:
 *  1. Score each article's sentiment per coin (-1 to +1)
 *  2. Average scores from two models for reliability
 *  3. Return a ranked list of trade opportunities
 */

import axios from 'axios';
import { SUPPORTED_COINS } from './newsFetcher.js';

const BATCH_SIZE = 15; // articles per LLM call to stay within context
const MIN_MERGED_CONFIDENCE = 0.65;

export class SentimentAnalyzer {
  constructor({
    apiKey,
    baseUrl = 'https://openrouter.ai/api/v1',
    primaryModel = 'meta-llama/llama-3.1-8b-instruct',
    secondaryModel = 'qwen/qwen-2.5-7b-instruct',
  }) {
    if (!apiKey) throw new Error('LLM_API_KEY is required');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.primaryModel = primaryModel;
    this.secondaryModel = secondaryModel;
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

    const [primaryScores, secondaryScores] = await Promise.all([
      this._analyzeWithModel(prompt, this.primaryModel),
      this._analyzeWithModel(prompt, this.secondaryModel),
    ]);

    return this._mergeModelScores(primaryScores, secondaryScores);
  }

  async _analyzeWithModel(prompt, model, attemptedModels = new Set()) {
    attemptedModels.add(model);
    const fallbackModel = this._getFallbackModel(model);
    try {
      return await this._requestAndParse(prompt, model);
    } catch (err) {
      console.error(`[Sentiment] ${model} parse error:`, err.response?.data?.error?.message || err.message);
      if (!fallbackModel || attemptedModels.has(fallbackModel)) return [];
      console.warn(`[Sentiment] Falling back from ${model} to ${fallbackModel}`);
      try {
        return await this._analyzeWithModel(prompt, fallbackModel, attemptedModels);
      } catch {
        return [];
      }
    }
  }

  _mergeModelScores(primaryScores, secondaryScores) {
    const primaryByCoin = new Map(primaryScores.map(s => [s.coin, s]));
    const secondaryByCoin = new Map(secondaryScores.map(s => [s.coin, s]));
    const merged = [];
    let missingSecond = 0;
    let signMismatch = 0;
    let lowConfidence = 0;

    for (const [coin, primary] of primaryByCoin.entries()) {
      const secondary = secondaryByCoin.get(coin);
      if (!secondary) {
        missingSecond++;
        continue;
      }

      const primarySign = Math.sign(primary.score);
      const secondarySign = Math.sign(secondary.score);
      if (primarySign === 0 || secondarySign === 0 || primarySign !== secondarySign) {
        signMismatch++;
        continue;
      }

      const mergedConfidence = (primary.confidence + secondary.confidence) / 2;
      if (mergedConfidence < MIN_MERGED_CONFIDENCE) {
        lowConfidence++;
        continue;
      }

      merged.push({
        coin,
        score: (primary.score + secondary.score) / 2,
        confidence: mergedConfidence,
        reasoning: `${this.primaryModel}: ${primary.reasoning} | ${this.secondaryModel}: ${secondary.reasoning}`,
      });
    }

    console.log(
      `[Sentiment] Agreement stats: accepted=${merged.length} missing_second=${missingSecond} sign_mismatch=${signMismatch} low_conf=${lowConfidence}`
    );

    return merged;
  }

  async _requestAndParse(prompt, model) {
    const { data } = await axios.post(
      `${this.baseUrl}/chat/completions`,
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1000,
        temperature: 0.2,
      },
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const raw = data?.choices?.[0]?.message?.content?.trim();
    if (!raw) return [];

    const parsed = this._parseModelJson(raw);
    return parsed
      .filter(r => SUPPORTED_COINS.includes(r.coin))
      .map(r => ({
        coin: r.coin,
        score: Math.max(-1, Math.min(1, Number(r.score) || 0)),
        confidence: Math.max(0.1, Math.min(1, Number(r.confidence) || 0.5)),
        reasoning: String(r.reasoning || '').slice(0, 100),
      }));
  }

  _parseModelJson(rawText) {
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (!match) throw new Error('No JSON array found in model output');
      return JSON.parse(match[0]);
    }
  }

  _getFallbackModel(model) {
    if (model === this.primaryModel) return this.secondaryModel;
    if (model === this.secondaryModel) return this.primaryModel;
    return null;
  }
}
