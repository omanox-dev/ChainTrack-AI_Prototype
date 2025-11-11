import React, { useState } from 'react'

export default function App() {
  const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:5000'
  const [txHash, setTxHash] = useState('')
  const [txData, setTxData] = useState(null)
  const [txLoading, setTxLoading] = useState(false)
  const [analysis, setAnalysis] = useState(null)
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [addr, setAddr] = useState('')
  const [addrTxs, setAddrTxs] = useState(null)
  const [addrPage, setAddrPage] = useState(1)
  const pageSize = 10
  const [addrLoading, setAddrLoading] = useState(false)
  const [addrError, setAddrError] = useState(null)

      async function fetchTx() {
        if (!txHash) return;
        setTxData(null); setAnalysis(null);
        setTxLoading(true)
        try {
          const r = await fetch(`${API_BASE}/api/tx/ethereum/${txHash}`)
          const data = await r.json()
          setTxData(data)
        } catch (err) {
          setTxData({ error: err.toString() })
        } finally {
          setTxLoading(false)
        }
  }

  async function analyzeTx() {
    if (!txData) return;
    setAnalysis(null)
    setAnalysisLoading(true)
    try {
      const r = await fetch(`${API_BASE}/api/analyze/tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(txData)
      })
      const data = await r.json()
      setAnalysis(data)
    } catch (err) {
      setAnalysis({ error: err.toString() })
    } finally {
      setAnalysisLoading(false)
    }
  }

  // Analyze a tx object immediately (useful when clicking a row so we don't rely on state update timing)
  async function analyzeTxImmediate(tx) {
    if (!tx) return
    setAnalysis(null)
    setAnalysisLoading(true)
    try {
      const r = await fetch(`${API_BASE}/api/analyze/tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tx)
      })
      const data = await r.json()
      setAnalysis(data)
    } catch (err) {
      setAnalysis({ error: err.toString() })
    } finally {
      setAnalysisLoading(false)
    }
  }

  // Trigger an explicit LLM-backed analysis (only when user requests it)
  async function analyzeWithLLM(tx) {
    if (!tx) return;
    setAnalysis(null);
    setAnalysisLoading(true);
    try {
      // send useLLM flag to instruct backend to run LLM-enriched analysis
      const payload = { ...tx, useLLM: true };
      const r = await fetch(`${API_BASE}/api/analyze/tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      setAnalysis(data);
    } catch (err) {
      setAnalysis({ error: err.toString() });
    } finally {
      setAnalysisLoading(false);
    }
  }

  async function fetchAddressTxs() {
    const q = (addr || '').trim()
    setAddrError(null)
    if (!q) { setAddrTxs(null); return }
    setAddrLoading(true)
    try {
      const r = await fetch(`${API_BASE}/api/address/ethereum/${q}/transactions`)
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
      const data = await r.json()
      // normalize result
      const txs = Array.isArray(data.transactions) ? data.transactions : (data.result || [])
      setAddrTxs(txs)
      setAddrPage(1)
    } catch (err) {
      setAddrTxs(null)
      setAddrError(err.toString())
    } finally {
      setAddrLoading(false)
    }
  }

  function onTxRowClick(tx) {
    // Load tx into the left panel for quick drilldown
    if (!tx) return
    setTxHash(tx.txHash)
    setTxData(tx)
    setAnalysis(null)
    // scroll to top so the user sees the tx details (UI convenience)
    try { window.scrollTo({ top: 0, behavior: 'smooth' }) } catch (e) {}
    // auto-run analysis shortly after loading the tx so users on touch can see results immediately
    setTimeout(() => analyzeTxImmediate(tx), 250)
  }

  function exportAddrCsv(pageOnly = true) {
    const rows = addrTxs || []
    const paged = pageOnly ? rows.slice((addrPage - 1) * pageSize, addrPage * pageSize) : rows
    const headers = ['txHash','from','to','value','tokenSymbol','blockNumber','timestamp','gasUsed','gasPriceGwei','isError']
    const lines = paged.map(t => headers.map(h => '"' + String(t[h] ?? '') .replace(/"/g,'""') + '"').join(','))
    const csv = `${headers.join(',')}\n${lines.join('\n')}`
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `address-${addr || 'address'}-page${addrPage}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  function formatJson(obj) {
    try {
      return JSON.stringify(obj, null, 2)
    } catch (e) {
      return String(obj)
    }
  }

  function formatEth(value) {
    // value may be in wei (string/number) or already human-readable
    if (value == null || value === '') return '—'
    try {
      const v = typeof value === 'string' ? BigInt(value) : BigInt(value)
      // convert wei to ETH with 6 decimals
      const eth = Number(v) / 1e18
      return `${eth.toFixed(6)} ETH`
    } catch (e) {
      // fallback: try parseFloat
      const f = parseFloat(value)
      if (isNaN(f)) return String(value)
      return `${(f).toFixed(6)} ETH`
    }
  }

  function formatGwei(value) {
    if (value == null || value === '') return '—'
    try {
      const v = typeof value === 'string' ? BigInt(value) : BigInt(value)
      const gwei = Number(v) / 1e9
      return `${gwei.toFixed(3)} Gwei`
    } catch (e) {
      const f = parseFloat(value)
      if (isNaN(f)) return String(value)
      return `${f.toFixed(3)} Gwei`
    }
  }

  function anomalyBadge(label) {
    const l = (label || '').toString().toLowerCase()
    if (l.includes('suspicious') || l.includes('fraud') || l.includes('high')) return { color: '#fff', bg: '#d9534f' }
    if (l.includes('benign') || l.includes('normal') || l.includes('low')) return { color: '#fff', bg: '#5cb85c' }
    return { color: '#222', bg: '#f0ad4e' }
  }

  function exportCsv() {
    // Exports basic tx + analysis as CSV with two rows: header and values
    const tx = txData || {}
    const an = analysis || {}
    const headers = ['txHash','from','to','value','tokenSymbol','blockNumber','timestamp','gasUsed','gasPriceGwei','anomaly_score','anomaly_label','nlpSummary']
    const values = [
      tx.txHash || tx.hash || '',
      tx.from || '',
      tx.to || '',
      tx.value || '',
      tx.tokenSymbol || '',
      tx.blockNumber || '',
      tx.timestamp || '',
      tx.gasUsed || '',
      tx.gasPriceGwei || (tx.gasPrice ? tx.gasPrice : ''),
      an?.anomaly?.score ?? (an?.score ?? ''),
      an?.anomaly?.label ?? (an?.label ?? ''),
      an?.nlpSummary || ''
    ]
    const csv = `${headers.join(',')}\n${values.map(v => '"' + String(v).replace(/"/g,'""') + '"').join(',')}`
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${tx.txHash || 'tx'}-report.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      <header className="ct-header">
        <div className="container">
          <div className="ct-title">ChainTrack AI</div>
          <div className="ct-sub">Prototype</div>
          <div className="ct-search">
            <input placeholder="Quick tx or address" value={txHash} onChange={e => setTxHash(e.target.value)} />
            <button className="cta" onClick={fetchTx}>Fetch</button>
          </div>
        </div>
      </header>

      <div className="ct-container">
        <div className="ct-layout">
          <main className="ct-main">
            <section style={{ marginBottom: 20 }}>
        <h2>Lookup Transaction</h2>
  <input placeholder="tx hash" value={txHash} onChange={e => setTxHash(e.target.value)} style={{ width: 400 }} />
  <button onClick={fetchTx} style={{ marginLeft: 8 }}>Fetch TX</button>
  <button onClick={analyzeTx} style={{ marginLeft: 8 }} disabled={!txData || analysisLoading}>Analyze</button>
  <button onClick={() => analyzeWithLLM(txData)} style={{ marginLeft: 8 }} disabled={!txData || analysisLoading} title="Run LLM-backed (Gemini) analysis - only use when you want a richer, potentially slower/costly result">Gemini Analyze</button>

        <div style={{ marginTop: 12, display: 'flex', gap: 20 }}>
          <div style={{ flex: 1 }}>
            <h3>Transaction Details</h3>
            {txLoading ? (
              <div className="panel">
                <div className="skeleton skeleton-line" style={{ width: '70%' }} />
                <div className="skeleton skeleton-line" style={{ width: '50%' }} />
                <div className="skeleton skeleton-line" style={{ width: '60%' }} />
                <div className="skeleton skeleton-line" style={{ width: '40%' }} />
                <div className="skeleton skeleton-line" style={{ width: '30%' }} />
              </div>
            ) : txData ? (
              <div style={{ background: '#f7f7f7', padding: 12, borderRadius: 6 }}>
                <div><strong>Tx:</strong> {txData.txHash || txData.hash}</div>
                <div><strong>From:</strong> {txData.from || '—'}</div>
                <div><strong>To:</strong> {txData.to || '—'}</div>
                <div><strong>Value:</strong> {txData.value ? formatEth(txData.value) : (txData.valueUSD ?? '—')} {txData.tokenSymbol || ''}</div>
                <div><strong>Block:</strong> {txData.blockNumber ?? '—'}</div>
                <div><strong>Timestamp:</strong> {txData.timestamp ?? txData.fetchedAt ?? '—'}</div>
                <div><strong>Gas used:</strong> {txData.gasUsed ?? '—'}</div>
                <div><strong>Gas price (Gwei):</strong> {txData.gasPriceGwei ? formatGwei(txData.gasPriceGwei) : (txData.gasPrice ? formatGwei(txData.gasPrice) : '—')}</div>
                <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                  <button onClick={() => navigator.clipboard && txData.txHash ? navigator.clipboard.writeText(txData.txHash) : null}>Copy TX</button>
                  <button onClick={exportCsv}>Export CSV</button>
                  <button onClick={() => { setAnalysis(null); setTimeout(() => analyzeTx(), 120) }} style={{ marginLeft: 'auto' }}>Retry Analysis</button>
                </div>
                <details style={{ marginTop: 8 }}>
                  <summary>Raw JSON</summary>
                  <pre style={{ maxHeight: 300, overflow: 'auto' }}>{formatJson(txData)}</pre>
                </details>
              </div>
            ) : (
              <pre>No tx loaded</pre>
            )}
          </div>

          <aside className="ct-aside">
            <div className="panel">
            <h3>AI Analysis</h3>
            {analysisLoading ? (
              <div className="panel">
                <div className="skeleton" style={{ height: 12, width: '60%', marginBottom: 8 }} />
                <div className="skeleton" style={{ height: 12, width: '40%', marginBottom: 8 }} />
                <div className="skeleton" style={{ height: 12, width: '80%', marginBottom: 8 }} />
              </div>
            ) : analysis ? (
              <div style={{ background: '#fff7ed', padding: 12, borderRadius: 6 }}>
                <div style={{ marginBottom: 6 }}><strong>Summary</strong></div>
                <div style={{ fontStyle: 'italic', marginBottom: 8 }}>{analysis.nlpSummary || (analysis.summary ?? 'No summary')}</div>

                <div style={{ marginBottom: 6 }}><strong>Anomaly</strong></div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, background: '#eee', height: 12, borderRadius: 6, overflow: 'hidden' }}>
                    <div style={{ width: `${Math.min(100, ((analysis?.anomaly?.score ?? analysis?.score ?? 0) * 100))}%`, height: '100%', background: (analysis?.anomaly?.score ?? analysis?.score ?? 0) > 0.85 ? '#d9534f' : '#5cb85c' }} />
                  </div>
                  <div style={{ minWidth: 60 }}><strong>{((analysis?.anomaly?.score ?? analysis?.score ?? 0) * 100).toFixed(1)}%</strong></div>
                </div>
                <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div><strong>Label:</strong></div>
                  <div style={{ padding: '4px 8px', borderRadius: 12, fontWeight: 600, ...anomalyBadge(analysis?.anomaly?.label ?? analysis?.label ?? '') }}>{analysis?.anomaly?.label ?? analysis?.label ?? 'unknown'}</div>
                  {analysis?.feePrediction && <div style={{ marginLeft: 'auto' }}><strong>Pred. fee:</strong> {analysis.feePrediction}</div>}
                </div>
                {analysis?.nlpSummary ? (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ marginBottom: 6 }}><strong>Summary</strong></div>
                    <div style={{ fontStyle: 'italic' }}>{analysis.nlpSummary}</div>
                  </div>
                ) : null}
                <details style={{ marginTop: 8 }}>
                  <summary>Full AI Response</summary>
                  <pre style={{ maxHeight: 300, overflow: 'auto' }}>{formatJson(analysis)}</pre>
                </details>
              </div>
            ) : (
              <pre>No analysis yet</pre>
            )}
            </div>
          </aside>
        </div>
      </section>

      <section style={{ marginBottom: 20 }}>
        <h2>Lookup Address</h2>
        <input placeholder="address" value={addr} onChange={e => setAddr(e.target.value)} style={{ width: 400 }} />
        <button onClick={fetchAddressTxs} style={{ marginLeft: 8 }}>Get Transactions</button>
        <div style={{ marginTop: 12 }}>
          {addrLoading ? (
            <div style={{ border: '1px solid #eee', borderRadius: 6, padding: 12 }}>
              {Array.from({length: pageSize}).map((_,i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 12, marginBottom: 8 }}>
                  <div className="skeleton skeleton-cell" style={{ width: '100%' }} />
                  <div className="skeleton skeleton-cell" style={{ width: '100%' }} />
                  <div className="skeleton skeleton-cell" style={{ width: '100%' }} />
                  <div className="skeleton skeleton-cell" style={{ width: '100%' }} />
                </div>
              ))}
            </div>
          ) : !addrTxs ? (
            <pre>No address data</pre>
          ) : (
            <div>
              <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                <div><strong>Address:</strong> {addr}</div>
                <div style={{ marginLeft: 'auto' }}><strong>Txs:</strong> {addrTxs.length}</div>
              </div>

              <div style={{ marginBottom: 8, display: 'flex', gap: 8 }}>
                <button onClick={() => exportAddrCsv(true)}>Export page CSV</button>
                <button onClick={() => exportAddrCsv(false)}>Export all CSV</button>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button onClick={() => setAddrPage(Math.max(1, addrPage - 1))} disabled={addrPage <= 1}>Previous</button>
                  <div>Page {addrPage} / {Math.max(1, Math.ceil((addrTxs.length || 0) / pageSize))}</div>
                  <button onClick={() => setAddrPage(Math.min(Math.ceil(addrTxs.length / pageSize), addrPage + 1))} disabled={addrPage >= Math.ceil(addrTxs.length / pageSize)}>Next</button>
                </div>
              </div>

              <div style={{ border: '1px solid #eee', borderRadius: 6, overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead style={{ background: '#fafafa', textAlign: 'left' }}>
                    <tr>
                      <th style={{ padding: '8px 10px' }}>Hash</th>
                      <th style={{ padding: '8px 10px' }}>From</th>
                      <th style={{ padding: '8px 10px' }}>To</th>
                      <th style={{ padding: '8px 10px' }}>Value</th>
                      <th style={{ padding: '8px 10px' }}>Block</th>
                      <th style={{ padding: '8px 10px' }}>Timestamp</th>
                      <th style={{ padding: '8px 10px' }}>GasPrice (Gwei)</th>
                      <th style={{ padding: '8px 10px' }}>Err</th>
                    </tr>
                  </thead>
                  <tbody>
                    { (addrTxs || []).slice((addrPage - 1) * pageSize, addrPage * pageSize).map(tx => (
                      <tr key={tx.txHash} onClick={() => onTxRowClick(tx)} style={{ cursor: 'pointer', borderTop: '1px solid #f0f0f0' }}>
                        <td style={{ padding: '8px 10px' }}>{tx.txHash ? `${tx.txHash.slice(0,10)}...${tx.txHash.slice(-6)}` : '—'}</td>
                        <td style={{ padding: '8px 10px' }}>{tx.from ? `${tx.from.slice(0,8)}...${tx.from.slice(-4)}` : '—'}</td>
                        <td style={{ padding: '8px 10px' }}>{tx.to ? `${tx.to.slice(0,8)}...${tx.to.slice(-4)}` : '—'}</td>
                        <td style={{ padding: '8px 10px' }}>{tx.value != null ? Number(tx.value).toFixed(6) : '—'}</td>
                        <td style={{ padding: '8px 10px' }}>{tx.blockNumber ?? '—'}</td>
                        <td style={{ padding: '8px 10px' }}>{tx.timestamp ? tx.timestamp.replace('T',' ').replace('.000Z','') : '—'}</td>
                        <td style={{ padding: '8px 10px' }}>{tx.gasPriceGwei != null ? tx.gasPriceGwei.toFixed(3) : '—'}</td>
                        <td style={{ padding: '8px 10px' }}>{tx.isError ? 'Y' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </section>

          </main>
        </div>

        <section>
        <h2>Notes</h2>
        <ul>
          <li>Backend must be running on <code>http://localhost:5000</code>.</li>
          <li>ML service (optional) should run on <code>http://localhost:8001</code>.</li>
          <li>Without API keys, tx lookups return mock data for the prototype.</li>
        </ul>
      </section>
      </div>
    </div>
  )
}
