import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';

export default function LogScan({ onScanLogged }) {
  const [feedback, setFeedback] = useState(null);
  const [passes, setPasses] = useState(0);
  const [fails, setFails] = useState(0);

  useEffect(() => {
    fetchTodayCounts();
  }, []);

  async function fetchTodayCounts() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const { data } = await supabase
      .from('daily_log')
      .select('result')
      .eq('employee', 'Scanner')
      .gte('timestamp', startOfDay.toISOString());

    const rows = data || [];
    setPasses(rows.filter((r) => r.result === 'Pass').length);
    setFails(rows.filter((r) => r.result === 'Fail').length);
  }

  async function handleScan(result) {
    const { error } = await supabase
      .from('daily_log')
      .insert({ employee: 'Scanner', result });

    if (!error) {
      setFeedback(result);
      onScanLogged(result);
      if (result === 'Pass') setPasses((p) => p + 1);
      else setFails((f) => f + 1);
      setTimeout(() => setFeedback(null), 800);
    }
  }

  return (
    <div className="page">
      <div className="card">
        <h3>Log Scan Result</h3>
        <div className="scan-buttons">
          <button className="scan-btn pass" onClick={() => handleScan('Pass')}>
            PASS
          </button>
          <button className="scan-btn fail" onClick={() => handleScan('Fail')}>
            FAIL
          </button>
        </div>
        {feedback && (
          <div className={`scan-feedback ${feedback.toLowerCase()}`}>
            {feedback === 'Pass' ? 'Passed' : 'Failed'} - Logged
          </div>
        )}
      </div>

      <div className="card">
        <h3>Today's Tally</h3>
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
      </div>
    </div>
  );
}
