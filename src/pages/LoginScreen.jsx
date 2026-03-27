import { useState } from 'react';
import { Disc3 } from 'lucide-react';

export default function LoginScreen({ onLogin }) {
  const [selected, setSelected] = useState('');

  return (
    <div className="login-screen">
      <Disc3 size={64} strokeWidth={1.5} color="#2563eb" />
      <h1>DVD Hub</h1>
      <p>Select your name to begin</p>
      <select
        className="login-select"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
      >
        <option value="">-- Choose Employee --</option>
        <option value="Scanner">Scanner</option>
        <option value="Cleaner">Cleaner</option>
      </select>
      <button
        className="login-btn"
        disabled={!selected}
        onClick={() => onLogin(selected)}
      >
        Start Shift
      </button>
    </div>
  );
}
