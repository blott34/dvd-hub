import { useState } from 'react';
import LoginScreen from './pages/LoginScreen';
import ScannerDashboard from './pages/ScannerDashboard';
import CleanerDashboard from './pages/CleanerDashboard';

export default function App() {
  const [employee, setEmployee] = useState(null);

  if (!employee) {
    return <LoginScreen onLogin={setEmployee} />;
  }

  const handleLogout = () => setEmployee(null);

  if (employee === 'Scanner') {
    return <ScannerDashboard onLogout={handleLogout} />;
  }

  return <CleanerDashboard onLogout={handleLogout} />;
}
