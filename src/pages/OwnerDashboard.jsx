import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

export default function OwnerDashboard() {
  const [dailyOverview, setDailyOverview] = useState({ total: 0, passed: 0, failed: 0, passRate: 0, shipments: 0 });
  const [employees, setEmployees] = useState({ Scanner: { clockedIn: false, hoursToday: 0 }, Cleaner: { clockedIn: false, hoursToday: 0 } });
  const [batches, setBatches] = useState([]);
  const [costs, setCosts] = useState({ todayPlacement: 0, todayShipping: 0, weekPlacement: 0, weekShipping: 0 });
  const [alerts, setAlerts] = useState([]);
  const [weeklySummary, setWeeklySummary] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAll();
  }, []);

  async function fetchAll() {
    await Promise.all([
      fetchDailyOverview(),
      fetchEmployeeStatus(),
      fetchBatches(),
      fetchCosts(),
      fetchSupplyAlerts(),
      fetchWeeklySummary(),
    ]);
    setLoading(false);
  }

  async function fetchDailyOverview() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const today = new Date().toISOString().split('T')[0];

    const [logRes, shipRes] = await Promise.all([
      supabase.from('daily_log').select('result').gte('timestamp', startOfDay.toISOString()),
      supabase.from('shipments_completed').select('id').eq('date', today),
    ]);

    const rows = logRes.data || [];
    const passed = rows.filter((r) => r.result === 'Pass').length;
    const failed = rows.filter((r) => r.result === 'Fail').length;
    const total = rows.length;

    setDailyOverview({
      total,
      passed,
      failed,
      passRate: total > 0 ? Math.round((passed / total) * 100) : 0,
      shipments: (shipRes.data || []).length,
    });
  }

  async function fetchEmployeeStatus() {
    const today = new Date().toISOString().split('T')[0];

    const { data: timesheets } = await supabase
      .from('timesheet')
      .select('*')
      .eq('date', today)
      .order('time_in', { ascending: true });

    const rows = timesheets || [];
    const result = {};

    for (const emp of ['Scanner', 'Cleaner']) {
      const empRows = rows.filter((r) => r.employee === emp);
      const hoursToday = empRows.reduce((sum, r) => sum + (parseFloat(r.hours_worked) || 0), 0);
      const lastPunch = empRows[empRows.length - 1];
      const clockedIn = lastPunch ? lastPunch.time_in && !lastPunch.time_out : false;
      result[emp] = { clockedIn, hoursToday };
    }

    setEmployees(result);
  }

  async function fetchBatches() {
    const { data } = await supabase
      .from('shipments_ready')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(30);
    setBatches(data || []);
  }

  async function fetchCosts() {
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = weekAgo.toISOString().split('T')[0];

    const { data } = await supabase
      .from('shipments_completed')
      .select('date, placement_fee, shipping_fee')
      .gte('date', weekAgoStr);

    const rows = data || [];
    const todayRows = rows.filter((r) => r.date === today);

    setCosts({
      todayPlacement: todayRows.reduce((s, r) => s + (parseFloat(r.placement_fee) || 0), 0),
      todayShipping: todayRows.reduce((s, r) => s + (parseFloat(r.shipping_fee) || 0), 0),
      weekPlacement: rows.reduce((s, r) => s + (parseFloat(r.placement_fee) || 0), 0),
      weekShipping: rows.reduce((s, r) => s + (parseFloat(r.shipping_fee) || 0), 0),
    });
  }

  async function fetchSupplyAlerts() {
    const { data } = await supabase.from('supply_tracker').select('*').order('item');
    const items = (data || []).filter((s) => s.current_stock <= s.order_trigger);
    setAlerts(items);
  }

  async function fetchWeeklySummary() {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = weekAgo.toISOString().split('T')[0];

    const { data } = await supabase
      .from('daily_summary')
      .select('*')
      .gte('date', weekAgoStr)
      .order('date', { ascending: false });

    setWeeklySummary(data || []);
  }

  function formatDate(d) {
    return new Date(d + 'T00:00:00').toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  }

  function formatBatchDate(ts) {
    return new Date(ts).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  }

  if (loading) {
    return (
      <div className="owner-dash">
        <div className="owner-loading">Loading dashboard...</div>
      </div>
    );
  }

  return (
    <div className="owner-dash">
      <header className="owner-header">
        <h1>DVD Hub - Owner Dashboard</h1>
        <span className="owner-date">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</span>
      </header>

      <div className="owner-grid">
        {/* Daily Overview */}
        <section className="owner-section">
          <h2>Daily Overview</h2>
          <div className="owner-stats">
            <div className="owner-stat">
              <div className="owner-stat-value">{dailyOverview.total}</div>
              <div className="owner-stat-label">Total Scans</div>
            </div>
            <div className="owner-stat">
              <div className="owner-stat-value" style={{ color: '#4ade80' }}>{dailyOverview.passed}</div>
              <div className="owner-stat-label">Passes</div>
            </div>
            <div className="owner-stat">
              <div className="owner-stat-value" style={{ color: '#f87171' }}>{dailyOverview.failed}</div>
              <div className="owner-stat-label">Fails</div>
            </div>
            <div className="owner-stat">
              <div className="owner-stat-value">{dailyOverview.passRate}%</div>
              <div className="owner-stat-label">Pass Rate</div>
            </div>
            <div className="owner-stat">
              <div className="owner-stat-value" style={{ color: '#60a5fa' }}>{dailyOverview.shipments}</div>
              <div className="owner-stat-label">Shipments</div>
            </div>
          </div>
        </section>

        {/* Employee Status */}
        <section className="owner-section">
          <h2>Employee Status</h2>
          <div className="owner-employees">
            {['Scanner', 'Cleaner'].map((emp, i) => (
              <div className="owner-emp-card" key={emp}>
                <div className="owner-emp-header">
                  <span className="owner-emp-name">Employee {i + 1}</span>
                  <span className="owner-emp-role">{emp}</span>
                </div>
                <div className="owner-emp-status">
                  <span className={`owner-clock-dot ${employees[emp]?.clockedIn ? 'in' : 'out'}`} />
                  <span>{employees[emp]?.clockedIn ? 'Clocked In' : 'Clocked Out'}</span>
                </div>
                <div className="owner-emp-hours">
                  {(employees[emp]?.hoursToday || 0).toFixed(1)}h today
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Shipments Pipeline */}
        <section className="owner-section owner-wide">
          <h2>Shipments Pipeline</h2>
          {batches.length === 0 ? (
            <div className="owner-empty">No batches in pipeline</div>
          ) : (
            <div className="owner-table-wrap">
              <table className="owner-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Quantity</th>
                    <th>Status</th>
                    <th>SKUs Listed</th>
                    <th>Gap</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => {
                    const gap = b.status === 'COMPLETED' && b.skus_listed != null
                      ? b.quantity - b.skus_listed
                      : null;
                    return (
                      <tr key={b.id}>
                        <td>{formatBatchDate(b.timestamp)}</td>
                        <td>{b.quantity}</td>
                        <td>
                          <span className={`owner-badge ${b.status === 'READY' ? 'badge-ready' : 'badge-done'}`}>
                            {b.status}
                          </span>
                        </td>
                        <td>{b.skus_listed ?? '--'}</td>
                        <td>
                          {gap != null ? (
                            <span style={{ color: gap > 0 ? '#f87171' : '#4ade80' }}>
                              {gap > 0 ? `${gap} unlisted` : 'All listed'}
                            </span>
                          ) : (
                            <span style={{ color: '#6b7280' }}>--</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Shipment Costs */}
        <section className="owner-section">
          <h2>Shipment Costs</h2>
          <div className="owner-costs">
            <div className="owner-cost-block">
              <h4>Today</h4>
              <div className="owner-cost-row">
                <span>Placement Fees</span>
                <span>${costs.todayPlacement.toFixed(2)}</span>
              </div>
              <div className="owner-cost-row">
                <span>Shipping Fees</span>
                <span>${costs.todayShipping.toFixed(2)}</span>
              </div>
              <div className="owner-cost-row total">
                <span>Total</span>
                <span>${(costs.todayPlacement + costs.todayShipping).toFixed(2)}</span>
              </div>
            </div>
            <div className="owner-cost-block">
              <h4>This Week</h4>
              <div className="owner-cost-row">
                <span>Placement Fees</span>
                <span>${costs.weekPlacement.toFixed(2)}</span>
              </div>
              <div className="owner-cost-row">
                <span>Shipping Fees</span>
                <span>${costs.weekShipping.toFixed(2)}</span>
              </div>
              <div className="owner-cost-row total">
                <span>Total</span>
                <span>${(costs.weekPlacement + costs.weekShipping).toFixed(2)}</span>
              </div>
            </div>
          </div>
        </section>

        {/* Supply Alerts */}
        <section className="owner-section">
          <h2>Supply Alerts</h2>
          {alerts.length === 0 ? (
            <div className="owner-empty" style={{ color: '#4ade80' }}>All supplies above trigger levels</div>
          ) : (
            <div className="owner-alerts">
              {alerts.map((s) => (
                <div className="owner-alert-item" key={s.id}>
                  <span className="owner-alert-name">{s.item}</span>
                  <span className="owner-alert-stock">
                    {s.current_stock} {s.unit}
                    <span className="owner-alert-trigger"> (trigger: {s.order_trigger})</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Weekly Summary */}
        <section className="owner-section owner-wide">
          <h2>Weekly Summary</h2>
          {weeklySummary.length === 0 ? (
            <div className="owner-empty">No summary data available</div>
          ) : (
            <div className="owner-table-wrap">
              <table className="owner-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Total Scans</th>
                    <th>Passes</th>
                    <th>Fails</th>
                    <th>Pass Rate</th>
                    <th>Shipments</th>
                  </tr>
                </thead>
                <tbody>
                  {weeklySummary.map((d) => {
                    const total = (d.passes || 0) + (d.fails || 0);
                    const rate = total > 0 ? Math.round(((d.passes || 0) / total) * 100) : 0;
                    return (
                      <tr key={d.date}>
                        <td>{formatDate(d.date)}</td>
                        <td>{d.total_scans ?? total}</td>
                        <td style={{ color: '#4ade80' }}>{d.passes ?? 0}</td>
                        <td style={{ color: '#f87171' }}>{d.fails ?? 0}</td>
                        <td>{d.pass_rate ?? rate}%</td>
                        <td>{d.shipments ?? 0}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
