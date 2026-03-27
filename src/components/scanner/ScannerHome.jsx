import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';

export default function ScannerHome({ clockedIn, onClockToggle, stats, shipmentCount }) {
  const target = 600;
  const pct = Math.min((stats.total / target) * 100, 100);

  return (
    <div className="page">
      <div className="card">
        <button
          className={`clock-btn ${clockedIn ? 'clock-out' : 'clock-in'}`}
          onClick={onClockToggle}
        >
          {clockedIn ? 'Clock Out' : 'Clock In'}
        </button>
        <div className="clock-status">
          {clockedIn ? 'You are clocked in' : 'You are clocked out'}
        </div>
      </div>

      <div className="card">
        <h3>Today's Stats</h3>
        <div className="stats-grid">
          <div className="stat-item">
            <div className="stat-value">{stats.total}</div>
            <div className="stat-label">Scanned</div>
          </div>
          <div className="stat-item">
            <div className="stat-value pass">{stats.passed}</div>
            <div className="stat-label">Passed</div>
          </div>
          <div className="stat-item">
            <div className="stat-value fail">{stats.failed}</div>
            <div className="stat-label">Failed</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{stats.passRate}%</div>
            <div className="stat-label">Pass Rate</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Shipments Today</h3>
        <div className="stat-item" style={{ background: 'transparent' }}>
          <div className="stat-value">{shipmentCount}</div>
          <div className="stat-label">Completed</div>
        </div>
      </div>

      <div className="card">
        <h3>Daily Progress</h3>
        <div className="progress-container">
          <div className="progress-label">
            <span>{stats.total} scans</span>
            <span>{target} target</span>
          </div>
          <div className="progress-bar">
            <div
              className={`progress-fill ${pct >= 100 ? 'complete' : ''}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
