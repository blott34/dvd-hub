import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';

export default function Supplies() {
  const [supplies, setSupplies] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSupplies();

    const channel = supabase
      .channel('supply-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'supply_tracker' }, () => {
        fetchSupplies();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  async function fetchSupplies() {
    const { data } = await supabase
      .from('supply_tracker')
      .select('*')
      .order('item');
    setSupplies(data || []);
    setLoading(false);
  }

  function getStockClass(item) {
    if (item.current_stock <= 0) return 'out';
    if (item.current_stock <= item.order_trigger) return 'low';
    return 'in-stock';
  }

  function getStockLabel(item) {
    if (item.current_stock <= 0) return 'Out';
    if (item.current_stock <= item.order_trigger) return 'Low';
    return 'In Stock';
  }

  if (loading) return <div className="empty-state">Loading supplies...</div>;

  return (
    <div className="page">
      <div className="card">
        <h3>Supply Inventory</h3>
        <table className="supply-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Stock</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {supplies.map((s) => (
              <tr key={s.id}>
                <td>{s.item}</td>
                <td>{s.current_stock} {s.unit}</td>
                <td>
                  <span className={`stock-badge ${getStockClass(s)}`}>
                    {getStockLabel(s)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
