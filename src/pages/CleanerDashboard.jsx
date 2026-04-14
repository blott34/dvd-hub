import { useState, useEffect, useCallback } from 'react';
import { Home, PackageCheck, Package, Clock } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { startVersionCheck } from '../lib/versionCheck';
import CleanerHome from '../components/cleaner/CleanerHome';
import BatchReady from '../components/cleaner/BatchReady';
import Supplies from '../components/shared/Supplies';
import MyHours from '../components/shared/MyHours';
import Toast from '../components/shared/Toast';

const TABS = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'batch', label: 'Batch Ready', icon: PackageCheck },
  { id: 'supplies', label: 'Supplies', icon: Package },
  { id: 'hours', label: 'My Hours', icon: Clock },
];

export default function CleanerDashboard({ onLogout }) {
  const [tab, setTab] = useState('home');
  const [clockedIn, setClockedIn] = useState(false);
  const [currentPunchId, setCurrentPunchId] = useState(null);
  const [batchCount, setBatchCount] = useState(0);
  const [totalReady, setTotalReady] = useState(0);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    checkClockStatus();
    fetchTodayBatches();
    startVersionCheck();
  }, []);

  async function checkClockStatus() {
    const today = new Date().toISOString().split('T')[0];
    const { data } = await supabase
      .from('timesheet')
      .select('*')
      .eq('employee', 'Cleaner')
      .eq('date', today)
      .is('time_out', null)
      .order('time_in', { ascending: false })
      .limit(1);

    if (data && data.length > 0) {
      setClockedIn(true);
      setCurrentPunchId(data[0].id);
    }
  }

  async function fetchTodayBatches() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const { data } = await supabase
      .from('shipments_ready')
      .select('quantity')
      .eq('employee', 'Cleaner')
      .gte('timestamp', startOfDay.toISOString());

    const rows = data || [];
    setBatchCount(rows.length);
    setTotalReady(rows.reduce((sum, r) => sum + r.quantity, 0));
  }

  async function handleClockToggle() {
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    if (!clockedIn) {
      const { data, error } = await supabase
        .from('timesheet')
        .insert({
          date: today,
          employee: 'Cleaner',
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
      const { data: record } = await supabase
        .from('timesheet')
        .select('time_in')
        .eq('id', currentPunchId)
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
        .eq('id', currentPunchId);

      if (!error) {
        setClockedIn(false);
        setCurrentPunchId(null);
        setToast('Clocked out');
      }
    }
  }

  const handleBatchLogged = useCallback(() => {
    fetchTodayBatches();
  }, []);

  return (
    <div className="app">
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}

      <div className="dash-header">
        <div>
          <h2>DVD Hub</h2>
        </div>
        <span className="role-badge cleaner">Cleaner</span>
        <button className="logout-btn" onClick={onLogout}>Logout</button>
      </div>

      {tab === 'home' && (
        <CleanerHome
          clockedIn={clockedIn}
          onClockToggle={handleClockToggle}
          batchCount={batchCount}
          totalReady={totalReady}
        />
      )}
      {tab === 'batch' && <BatchReady onBatchLogged={handleBatchLogged} />}
      {tab === 'supplies' && <Supplies />}
      {tab === 'hours' && <MyHours employee="Cleaner" />}

      <div className="tab-bar cleaner">
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
