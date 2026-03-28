import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';

export default function MyHours({ employee }) {
  const [punches, setPunches] = useState([]);
  const [weekTotal, setWeekTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchPunches();
  }, [employee]);

  async function fetchPunches() {
    // Get punches from the last 7 days
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const { data } = await supabase
      .from('timesheet')
      .select('*')
      .eq('employee', employee)
      .gte('date', weekAgo.toISOString().split('T')[0])
      .order('date', { ascending: true })
      .order('time_in', { ascending: true });

    const rows = data || [];
    setPunches(rows);

    const total = rows.reduce((sum, p) => sum + (parseFloat(p.hours_worked) || 0), 0);
    setWeekTotal(total);
    setLoading(false);
  }

  function formatTime(ts) {
    if (!ts) return '--';
    return new Date(ts).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function formatDate(d) {
    return new Date(d + 'T00:00:00').toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  }

  if (loading) return <div className="empty-state">Loading hours...</div>;

  return (
    <div className="page">
      <div className="week-total">
        This Week: {weekTotal.toFixed(1)} hrs
      </div>

      <div className="card">
        <h3>Punch History</h3>
        {punches.length === 0 ? (
          <div className="empty-state">No punches this week</div>
        ) : (
          <table className="hours-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>In</th>
                <th>Out</th>
                <th>Hours</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {punches.reduce((acc, p) => {
                const hrs = parseFloat(p.hours_worked) || 0;
                const cumulative = (acc.length > 0 ? acc[acc.length - 1].cumulative : 0) + hrs;
                acc.push({ ...p, cumulative });
                return acc;
              }, []).map((p) => (
                <tr key={p.id}>
                  <td>{formatDate(p.date)}</td>
                  <td>{formatTime(p.time_in)}</td>
                  <td>{formatTime(p.time_out)}</td>
                  <td>{p.hours_worked ? `${parseFloat(p.hours_worked).toFixed(1)}h` : '--'}</td>
                  <td style={{ fontWeight: 600 }}>{p.cumulative.toFixed(1)}h</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
                <td colSpan={3} style={{ paddingTop: 12 }}>Week Total</td>
                <td style={{ paddingTop: 12 }}>{weekTotal.toFixed(1)}h</td>
                <td style={{ paddingTop: 12 }}>{weekTotal.toFixed(1)}h</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}
