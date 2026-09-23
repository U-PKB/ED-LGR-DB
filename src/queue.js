import { analyseEntry, describeError, isAnalysisConfigured } from './analyse.js';
import { loadSource } from './content.js';
import { ANALYSIS_STATUS } from './constants.js';

/**
 * Runs analyses one at a time in the background so adding an entry returns
 * immediately. The page polls for the result.
 */
export function createAnalysisQueue(db, uploadsDir, { analyse = analyseEntry } = {}) {
  const waiting = [];
  let running = false;

  async function runNext() {
    if (running) return;
    const id = waiting.shift();
    if (id === undefined) return;
    running = true;
    try {
      await analyseOne(id);
    } finally {
      running = false;
      runNext();
    }
  }

  async function analyseOne(id) {
    const entry = db.get(id);
    if (!entry) return;
    db.update(id, { analysis_status: ANALYSIS_STATUS.PROCESSING, analysis_error: null });
    try {
      const source = await loadSource(entry, uploadsDir);
      const result = await analyse(entry, source);
      const current = db.get(id);
      if (!current) return; // deleted while being analysed
      db.update(id, {
        relevance: result.relevance,
        briefing: result.briefing,
        key_messages: result.key_messages,
        keywords: current.keywords.trim() ? current.keywords : result.suggested_keywords.join(', '),
        analysis_status: ANALYSIS_STATUS.COMPLETE,
        // Questions have no source to read, so only flag unreadable links and documents.
        analysis_error:
          source.kind === 'none' && (entry.link || entry.attachment_path) ? source.reason : null,
        analysed_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`Analysis of entry ${id} failed:`, err);
      if (db.get(id)) {
        db.update(id, { analysis_status: ANALYSIS_STATUS.FAILED, analysis_error: describeError(err) });
      }
    }
  }

  return {
    enqueue(id) {
      if (analyse === analyseEntry && !isAnalysisConfigured()) {
        db.update(id, {
          analysis_status: ANALYSIS_STATUS.NOT_CONFIGURED,
          analysis_error: 'Automatic analysis is switched off because no Anthropic API key is set.',
        });
        return;
      }
      if (!waiting.includes(id)) waiting.push(id);
      db.update(id, { analysis_status: ANALYSIS_STATUS.PENDING, analysis_error: null });
      runNext();
    },

    // Picks up anything left unfinished when the server last stopped.
    resume() {
      for (const id of db.idsWithStatus(ANALYSIS_STATUS.PENDING, ANALYSIS_STATUS.PROCESSING)) {
        this.enqueue(id);
      }
    },

    get idle() {
      return !running && waiting.length === 0;
    },
  };
}
