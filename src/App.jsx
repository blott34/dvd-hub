import { useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import LoginScreen from './pages/LoginScreen';
import ScannerDashboard from './pages/ScannerDashboard';
import CleanerDashboard from './pages/CleanerDashboard';
import OwnerDashboard from './pages/OwnerDashboard';

function EmployeeApp() {
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

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/owner" element={<OwnerDashboard />} />
        <Route path="*" element={<EmployeeApp />} />
      </Routes>
    </BrowserRouter>
  );
}
