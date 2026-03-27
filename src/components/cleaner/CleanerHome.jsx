export default function CleanerHome({ clockedIn, onClockToggle, batchCount, totalReady }) {
  return (
    <div className="page">
      <div className="card">
        <button
          className={`clock-btn ${clockedIn ? 'clock-out' : 'clock-in cleaner'}`}
          onClick={onClockToggle}
        >
          {clockedIn ? 'Clock Out' : 'Clock In'}
        </button>
        <div className="clock-status">
          {clockedIn ? 'You are clocked in' : 'You are clocked out'}
        </div>
      </div>

      <div className="card">
        <h3>Today's Work</h3>
        <div className="stats-grid">
          <div className="stat-item">
            <div className="stat-value">{batchCount}</div>
            <div className="stat-label">Batches Today</div>
          </div>
          <div className="stat-item">
            <div className="stat-value" style={{ color: '#7c3aed' }}>{totalReady}</div>
            <div className="stat-label">DVDs Marked Ready</div>
          </div>
        </div>
      </div>
    </div>
  );
}
