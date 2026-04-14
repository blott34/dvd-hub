import { useState, useEffect, useCallback } from 'react';
import { Home, ScanLine, Truck, Package, Clock } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { startVersionCheck } from '../lib/versionCheck';
import ScannerHome from '../components/scanner/ScannerHome';
import LogScan from '../components/scanner/LogScan';
import Shipment from '../components/scanner/Shipment';
import Supplies from '../components/shared/Supplies';
import MyHours from '../components/shared/MyHours';
import Toast from '../components/shared/Toast';

const TABS = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'scan', label: 'Log Scan', icon: ScanLine },
  { id: 'shipment', label: 'Shipment', icon: Truck },
  { id: 'supplies', label: 'Supplies', icon: Package },
  { id: 'hours', label: 'My Hours', icon: Clock },
];

export default function ScannerDashboard({ onLogout }) {
  const [tab, setTab] = useState('home');
  const [clockedIn, setClockedIn] = useState(false);
  const [currentPunchId, setCurrentPunchId] = useState(null);
  const [stats, setStats] = useState({ total: 0, passed: 0, failed: 0, passRate: 0 });
  const [shipmentCount, setShipmentCount] = useState(0);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    checkClockStatus();
    fetchTodayStats();
    fetchShipmentCount();
    startVersionCheck();
  }, []);

  async function checkClockStatus() {
    const today = new Date().toISOString().split('T')[0];
    const { data } = await supabase
      .from('timesheet')
      .select('*')
      .eq('employee', 'Scanner')
      .eq('date', today)
      .is('time_out', null)
      .order('time_in', { ascending: false })
      .limit(1);

    if (data && data.length > 0) {
      setClockedIn(true);
      setCurrentPunchId(data[0].id);
    }
  }

  async function fetchTodayStats() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const { data } = await supabase
      .from('daily_log')
      .select('result')
      .eq('employee', 'Scanner')
      .gte('timestamp', startOfDay.toISOString());

    const rows = data || [];
    const passed = rows.filter((r) => r.result === 'Pass').length;
    const failed = rows.filter((r) => r.result === 'Fail').length;
    const total = rows.length;
    const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

    setStats({ total, passed, failed, passRate });
  }

  async function fetchShipmentCount() {
    const today = new Date().toISOString().split('T')[0];
    const { count } = await supabase
      .from('shipments_completed')
      .select('*', { count: 'exact', head: true })
      .eq('date', today);
    setShipmentCount(count || 0);
  }

  async function handleClockToggle() {
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    if (!clockedIn) {
      // Clock in
      const { data, error } = await supabase
        .from('timesheet')
        .insert({
          date: today,
          employee: 'Scanner',
          type: 'IN',
          time_in: now.toISOString(),
        })
        .select()
        .single();

      if (!error) {
        setClockedIn(true);
        setCurrentPunchId(data.id);
        setToast('Clocked in');
      }
    } else {
      // Clock out - update existing punch
      const clockInRecord = currentPunchId;
      const { data: record } = await supabase
        .from('timesheet')
        .select('time_in')
        .eq('id', clockInRecord)
        .single();

      const timeIn = new Date(record.time_in);
      const hoursWorked = ((now - timeIn) / 3600000).toFixed(2);

      const { error } = await supabase
        .from('timesheet')
        .update({
          type: 'OUT',
          time_out: now.toISOString(),
          hours_worked: parseFloat(hoursWorked),
        })
        .eq('id', clockInRecord);

      if (!error) {
        setClockedIn(false);
        setCurrentPunchId(null);
        // Reset stats on clock out
        setStats({ total: 0, passed: 0, failed: 0, passRate: 0 });
        setToast('Clocked out');
      }
    }
  }

  const handleScanLogged = useCallback((result) => {
    setStats((prev) => {
      const passed = prev.passed + (result === 'Pass' ? 1 : 0);
      const failed = prev.failed + (result === 'Fail' ? 1 : 0);
      const total = passed + failed;
      const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;
      return { total, passed, failed, passRate };
    });
  }, []);

  const handleShipmentLogged = useCallback(() => {
    setShipmentCount((c) => c + 1);
  }, []);

  return (
    <div className="app">
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}

      <div className="dash-header">
        <div>
          <h2>DVD Hub</h2>
        </div>
        <span className="role-badge scanner">Scanner</span>
        <button className="logout-btn" onClick={onLogout}>Logout</button>
      </div>

      {tab === 'home' && (
        <ScannerHome
          clockedIn={clockedIn}
          onClockToggle={handleClockToggle}
          stats={stats}
          shipmentCount={shipmentCount}
        />
      )}
      {tab === 'scan' && <LogScan onScanLogged={handleScanLogged} />}
      {tab === 'shipment' && <Shipment onShipmentLogged={handleShipmentLogged} />}
      {tab === 'supplies' && <Supplies />}
      {tab === 'hours' && <MyHours employee="Scanner" />}

      <div className="tab-bar">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            <Icon size={20} />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
