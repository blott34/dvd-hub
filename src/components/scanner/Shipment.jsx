import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import Toast from '../shared/Toast';

export default function Shipment({ onShipmentLogged }) {
  const [placementFee, setPlacementFee] = useState('16.00');
  const [shippingFee, setShippingFee] = useState('11.50');
  const [shipments, setShipments] = useState([]);
  const [toast, setToast] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const total = (parseFloat(placementFee) || 0) + (parseFloat(shippingFee) || 0);

  useEffect(() => {
    fetchShipments();
  }, []);

  async function fetchShipments() {
    const today = new Date().toISOString().split('T')[0];
    const { data } = await supabase
      .from('shipments_completed')
      .select('*')
      .eq('date', today)
      .order('shipment_number', { ascending: false });
    setShipments(data || []);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);

    const today = new Date().toISOString().split('T')[0];
    const nextNum = shipments.length + 1;

    const { error } = await supabase.from('shipments_completed').insert({
      date: today,
      employee: 'Scanner',
      shipment_number: nextNum,
      units: 100,
      placement_fee: parseFloat(placementFee),
      shipping_fee: parseFloat(shippingFee),
      total_cost: total,
    });

    setSubmitting(false);

    if (!error) {
      setToast('Shipment logged');
      onShipmentLogged();
      fetchShipments();
      setPlacementFee('16.00');
      setShippingFee('11.50');
    } else {
      setToast('Error logging shipment');
    }
  }

  return (
    <div className="page">
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}

      <div className="card">
        <h3>Log Shipment</h3>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Placement Fee ($)</label>
            <input
              type="number"
              step="0.01"
              value={placementFee}
              onChange={(e) => setPlacementFee(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>Shipping Fee ($)</label>
            <input
              type="number"
              step="0.01"
              value={shippingFee}
              onChange={(e) => setShippingFee(e.target.value)}
            />
          </div>
          <div className="total-display">Total: ${total.toFixed(2)}</div>
          <button className="submit-btn" type="submit" disabled={submitting}>
            {submitting ? 'Logging...' : 'Log Shipment'}
          </button>
        </form>
      </div>

      <div className="card">
        <h3>Shipments Today</h3>
        {shipments.length === 0 ? (
          <div className="empty-state">No shipments yet today</div>
        ) : (
          <table className="history-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Units</th>
                <th>Placement</th>
                <th>Shipping</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {shipments.map((s) => (
                <tr key={s.id}>
                  <td>{s.shipment_number}</td>
                  <td>{s.units}</td>
                  <td>${parseFloat(s.placement_fee).toFixed(2)}</td>
                  <td>${parseFloat(s.shipping_fee).toFixed(2)}</td>
                  <td>${parseFloat(s.total_cost).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
