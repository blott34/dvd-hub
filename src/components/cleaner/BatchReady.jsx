import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import Toast from '../shared/Toast';

export default function BatchReady({ onBatchLogged }) {
  const [quantity, setQuantity] = useState('100');
  const [notes, setNotes] = useState('');
  const [batches, setBatches] = useState([]);
  const [toast, setToast] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [editingSkus, setEditingSkus] = useState({});

  useEffect(() => {
    fetchBatches();
  }, []);

  async function fetchBatches() {
    const { data } = await supabase
      .from('shipments_ready')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(20);
    setBatches(data || []);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);

    const { error } = await supabase.from('shipments_ready').insert({
      employee: 'Cleaner',
      quantity: parseInt(quantity),
      notes: notes || null,
    });

    setSubmitting(false);

    if (!error) {
      setToast('Batch marked ready');
      onBatchLogged();
      fetchBatches();
      setQuantity('100');
      setNotes('');
    }
  }

  async function handleComplete(id) {
    const skus = editingSkus[id] || null;
    const { error } = await supabase
      .from('shipments_ready')
      .update({ status: 'COMPLETED', skus_listed: skus ? parseInt(skus) : null })
      .eq('id', id);

    if (!error) {
      setToast('Batch completed');
      fetchBatches();
    }
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  return (
    <div className="page">
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}

      <div className="card">
        <form onSubmit={handleSubmit}>
          <button className="batch-btn" type="submit" disabled={submitting}>
            {submitting ? 'Logging...' : 'Mark Batch Ready'}
          </button>
          <div className="form-group">
            <label>Quantity</label>
            <input
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>Notes (optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any notes about this batch..."
            />
          </div>
        </form>
      </div>

      <div className="card">
        <h3>Recent Batches</h3>
        {batches.length === 0 ? (
          <div className="empty-state">No batches yet</div>
        ) : (
          <table className="ready-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Qty</th>
                <th>Status</th>
                <th>SKUs</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td>{formatTime(b.timestamp)}</td>
                  <td>{b.quantity}</td>
                  <td>
                    <span className={`status-badge ${b.status.toLowerCase()}`}>
                      {b.status}
                    </span>
                  </td>
                  <td>
                    {b.status === 'READY' ? (
                      <input
                        className="skus-input"
                        type="number"
                        placeholder="--"
                        value={editingSkus[b.id] || ''}
                        onChange={(e) =>
                          setEditingSkus({ ...editingSkus, [b.id]: e.target.value })
                        }
                      />
                    ) : (
                      b.skus_listed ?? '--'
                    )}
                  </td>
                  <td>
                    {b.status === 'READY' && (
                      <button
                        className="complete-btn"
                        onClick={() => handleComplete(b.id)}
                      >
                        Done
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
