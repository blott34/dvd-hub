import { useState } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
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

const router = createBrowserRouter([
  { path: '/owner', element: <OwnerDashboard /> },
  { path: '*', element: <EmployeeApp /> },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
