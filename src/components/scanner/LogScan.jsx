import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';

// rAF runs after React commits and before the next paint — by then the DOM
// reflects the latest state and the input is in its final focusable form.
// setTimeout(0) would also work but rAF is the canonical "after-DOM-update" hook.
function refocusInput(ref) {
  requestAnimationFrame(() => ref.current?.focus());
}

export default function LogScan({ onScanLogged }) {
  const [feedback, setFeedback] = useState(null);
  const [passes, setPasses] = useState(0);
  const [fails, setFails] = useState(0);

  const [upc, setUpc] = useState('');
  const [loading, setLoading] = useState(false);
  const [currentScan, setCurrentScan] = useState(null);
  const [tokensLeft, setTokensLeft] = useState(null);
  const [agreementStats, setAgreementStats] = useState(null);
  const inputRef = useRef(null);
  const agreementCacheRef = useRef({ data: null, fetchedAt: 0 });

  useEffect(() => {
    fetchTodayCounts();
    fetchAgreementStats();
    refocusInput(inputRef);
  }, []);

  async function fetchTodayCounts() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const { data } = await supabase
      .from('scan_logs')
      .select('manual_verdict, automated_verdict')
      .eq('employee', 'Scanner')
      .gte('created_at', startOfDay.toISOString());

    const rows = data || [];
    const ev = (r) => r.manual_verdict || r.automated_verdict;
    setPasses(rows.filter((r) => ev(r) === 'pass').length);
    setFails(rows.filter((r) => ev(r) === 'fail').length);
  }

  async function fetchAgreementStats() {
    const now = Date.now();
    const cache = agreementCacheRef.current;
    if (cache.data && now - cache.fetchedAt < 30000) {
      setAgreementStats(cache.data);
      return;
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const { data } = await supabase
      .from('scan_logs')
      .select('verdict_agreement')
      .eq('employee', 'Scanner')
      .gte('created_at', startOfDay.toISOString())
      .not('verdict_agreement', 'is', null);

    const rows = data || [];
    const agreed = rows.filter((r) => r.verdict_agreement === true).length;
    const total = rows.length;
    const result = {
      agreed,
      total,
      rate: total > 0 ? Math.round((agreed / total) * 100) : null,
    };
    agreementCacheRef.current = { data: result, fetchedAt: Date.now() };
    setAgreementStats(result);
  }

  async function handleUpcSubmit(e) {
    e.preventDefault();
    const trimmed = upc.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setCurrentScan(null);
    setFeedback(null);

    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
      const res = await fetch(`${supabaseUrl}/functions/v1/keepa-lookup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify({ upc: trimmed }),
      });
      const result = await res.json();

      if (result.tokens_left != null) setTokensLeft(result.tokens_left);

      const { data: row, error } = await supabase
        .from('scan_logs')
        .insert({
          employee: 'Scanner',
          upc: trimmed,
          keepa_asin: result.asin || null,
          keepa_candidate_asins: result.candidate_asins || null,
          keepa_snapshot: result.snapshot || null,
          automated_verdict: result.verdict,
          automated_rule_triggered: result.rule_triggered || null,
          keepa_tokens_left: result.tokens_left != null ? result.tokens_left : null,
          keepa_lookup_ms: result.lookup_ms != null ? result.lookup_ms : null,
        })
        .select('id')
        .single();

      if (!error && row) {
        setCurrentScan({
          id: row.id,
          verdict: result.verdict,
          rule: result.rule_triggered,
          snapshot: result.snapshot,
          asin: result.asin,
          manualVerdict: null,
        });
      }
    } catch {
      setCurrentScan({
        id: null,
        verdict: 'error',
        rule: 'network_error',
        snapshot: null,
        asin: null,
        manualVerdict: null,
      });
    } finally {
      setLoading(false);
      setUpc('');
      refocusInput(inputRef);
    }
  }

  async function handleManualVerdict(verdict) {
    if (currentScan?.id) {
      await supabase
        .from('scan_logs')
        .update({ manual_verdict: verdict })
        .eq('id', currentScan.id);
      setCurrentScan((prev) => (prev ? { ...prev, manualVerdict: verdict } : null));
    } else {
      await supabase
        .from('scan_logs')
        .insert({ employee: 'Scanner', manual_verdict: verdict });
    }

    setFeedback(verdict);
    onScanLogged(verdict);
    if (verdict === 'pass') setPasses((p) => p + 1);
    else setFails((f) => f + 1);
    setTimeout(() => setFeedback(null), 800);
    fetchAgreementStats();
    setUpc('');
    refocusInput(inputRef);
  }

  function formatPrice(cents) {
    if (cents == null || cents < 0) return '\u2014';
    return '$' + (cents / 100).toFixed(2);
  }

  function formatRank(rank) {
    if (rank == null) return '\u2014';
    if (rank >= 1000000) return (rank / 1000000).toFixed(1) + 'M';
    if (rank >= 1000) return Math.round(rank / 1000) + 'k';
    return String(rank);
  }

  function tokenColor(tokens) {
    if (tokens == null) return '#94a3b8';
    if (tokens >= 50) return '#16a34a';
    if (tokens >= 20) return '#d97706';
    return '#dc2626';
  }

  const verdictColors = {
    pass: { bg: '#dcfce7', border: '#16a34a', text: '#15803d' },
    fail: { bg: '#fee2e2', border: '#dc2626', text: '#991b1b' },
    error: { bg: '#f1f5f9', border: '#94a3b8', text: '#475569' },
  };

  const showDisagreement =
    currentScan?.manualVerdict &&
    currentScan.manualVerdict !== currentScan.verdict &&
    currentScan.verdict !== 'error';

  return (
    <div className="page">
      {/* Top-right widgets */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 16,
          marginBottom: 12,
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        {tokensLeft != null && (
          <span style={{ color: tokenColor(tokensLeft) }}>Tokens: {tokensLeft}</span>
        )}
        {agreementStats?.rate != null && (
          <span style={{ color: '#64748b' }}>
            Agreement {agreementStats.rate}% ({agreementStats.agreed}/{agreementStats.total})
          </span>
        )}
      </div>

      {/* UPC Input */}
      <div className="card">
        <h3>Scan UPC</h3>
        <form onSubmit={handleUpcSubmit}>
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            value={upc}
            // gate onChange instead of disabling the input — a disabled input
            // loses focus and cannot regain it via .focus(), which was the
            // root cause of the bug. readOnly keeps it focusable; the onChange
            // guard drops any stray scanner characters during the API call.
            onChange={(e) => { if (!loading) setUpc(e.target.value); }}
            placeholder="Scan or type UPC..."
            readOnly={loading}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            style={{
              width: '100%',
              padding: 16,
              fontSize: 20,
              fontWeight: 600,
              border: '2px solid var(--border)',
              borderRadius: 8,
              textAlign: 'center',
              background: 'var(--card)',
            }}
          />
        </form>
        {loading && (
          <div style={{ textAlign: 'center', padding: 20, color: '#64748b', fontSize: 16 }}>
            Looking up...
          </div>
        )}
      </div>

      {/* Verdict Banner */}
      {currentScan && !loading && (
        <div
          tabIndex={-1}
          style={{
            padding: 16,
            borderRadius: 12,
            border: `2px solid ${showDisagreement ? '#d97706' : (verdictColors[currentScan.verdict]?.border || '#94a3b8')}`,
            background: showDisagreement
              ? '#fefce8'
              : (verdictColors[currentScan.verdict]?.bg || '#f1f5f9'),
            marginBottom: 16,
            outline: 'none',
          }}
        >
          {showDisagreement ? (
            <div
              style={{ textAlign: 'center', fontWeight: 700, fontSize: 18, color: '#92400e' }}
            >
              Disagreement logged
            </div>
          ) : (
            <>
              <div
                style={{
                  fontSize: 24,
                  fontWeight: 700,
                  color: verdictColors[currentScan.verdict]?.text || '#475569',
                  textAlign: 'center',
                }}
              >
                {currentScan.verdict.toUpperCase()}
                {currentScan.rule && (
                  <span style={{ fontSize: 14, fontWeight: 500, marginLeft: 8 }}>
                    {currentScan.rule}
                  </span>
                )}
              </div>
              {currentScan.snapshot && (
                <div
                  style={{
                    textAlign: 'center',
                    fontSize: 13,
                    color: '#475569',
                    marginTop: 8,
                  }}
                >
                  BB {formatPrice(currentScan.snapshot.current_bb)}
                  {currentScan.snapshot.avg90_bb != null &&
                    ` (90d ${formatPrice(currentScan.snapshot.avg90_bb)})`}
                  {'  \u2022  '}
                  Rank {formatRank(currentScan.snapshot.current_rank)}
                  {'  \u2022  '}
                  Sold/mo {currentScan.snapshot.monthly_sold ?? '\u2014'}
                  {'  \u2022  '}
                  ASIN {currentScan.asin || '\u2014'}
                </div>
              )}
              {!currentScan.manualVerdict && (
                <div
                  style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', marginTop: 8 }}
                >
                  Click PASS or FAIL to record your call
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Manual PASS/FAIL buttons */}
      <div className="card">
        <h3>Log Scan Result</h3>
        <div className="scan-buttons">
          <button className="scan-btn pass" onClick={() => handleManualVerdict('pass')}>
            PASS
          </button>
          <button className="scan-btn fail" onClick={() => handleManualVerdict('fail')}>
            FAIL
          </button>
        </div>
        {feedback && (
          <div className={`scan-feedback ${feedback}`}>
            {feedback === 'pass' ? 'Passed' : 'Failed'} - Logged
          </div>
        )}
      </div>

      <div className="card">
        <h3>Today&apos;s Tally</h3>
        <div className="stats-grid">
          <div className="stat-item">
            <div className="stat-value pass">{passes}</div>
            <div className="stat-label">Passes</div>
          </div>
          <div className="stat-item">
            <div className="stat-value fail">{fails}</div>
            <div className="stat-label">Fails</div>
          </div>
        </div>
        <div
          style={{
            marginTop: 16,
            paddingTop: 12,
            borderTop: '2px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            fontWeight: 700,
            fontSize: '0.95rem',
          }}
        >
          <span>Totals</span>
          <span>
            <span style={{ color: '#16a34a' }}>{passes} Pass</span>
            {' / '}
            <span style={{ color: '#dc2626' }}>{fails} Fail</span>
            {' / '}
            <span>{passes + fails} Total</span>
          </span>
        </div>
      </div>
    </div>
  );
}
