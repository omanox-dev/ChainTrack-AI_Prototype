import React, { useState } from 'react'
import './styles.css'
import LivePrices from './components/LivePrices'

export default function App() {
  const apiBase = 'http://localhost:5010'
  const [currentPage, setCurrentPage] = useState('analysis') // 'analysis' or 'prices'
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
      const r = await fetch(`${apiBase}/api/tx/ethereum/${txHash}`)
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
      const r = await fetch(`${apiBase}/api/analyze/tx`, {
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

  async function analyzeTxImmediate(tx) {
    if (!tx) return
    setAnalysis(null)
    setAnalysisLoading(true)
    try {
      const r = await fetch(`${apiBase}/api/analyze/tx`, {
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

  async function analyzeWithLLM(tx) {
    if (!tx) return;
    setAnalysis(null);
    setAnalysisLoading(true);
    try {
      const payload = { ...tx, useLLM: true };
      const r = await fetch(`${apiBase}/api/analyze/tx`, {
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
      const r = await fetch(`${apiBase}/api/address/ethereum/${q}/transactions`)
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
      const data = await r.json()
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
    if (!tx) return
    setTxHash(tx.txHash)
    setTxData(tx)
    setAnalysis(null)
    try { window.scrollTo({ top: 0, behavior: 'smooth' }) } catch (e) {}
    setTimeout(() => analyzeTxImmediate(tx), 250)
  }

  function exportAddrCsv(pageOnly = true) {
    const rows = addrTxs || []
    const paged = pageOnly ? rows.slice((addrPage - 1) * pageSize, addrPage * pageSize) : rows
    const headers = ['txHash','from','to','value','tokenSymbol','blockNumber','timestamp','gasUsed','gasPriceGwei','isError']
    const lines = paged.map(t => headers.map(h => '"' + String(t[h] ?? '').replace(/"/g,'""') + '"').join(','))
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
    if (value == null || value === '') return '—'
    try {
      const v = typeof value === 'string' ? BigInt(value) : BigInt(value)
      const eth = Number(v) / 1e18
      return `${eth.toFixed(6)} ETH`
    } catch (e) {
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
    <div className="ct-app">
      {/* Header */}
      <header className="ct-header">
        <div className="header-content">
          <h1 className="brand">⛓️ ChainTrack AI</h1>
          <nav className="nav-tabs">
            <button 
              className={`nav-tab ${currentPage === 'analysis' ? 'active' : ''}`}
              onClick={() => setCurrentPage('analysis')}
            >
              🔍 Transaction Analysis
            </button>
            <button 
              className={`nav-tab ${currentPage === 'prices' ? 'active' : ''}`}
              onClick={() => setCurrentPage('prices')}
            >
              💰 Live Prices
            </button>
          </nav>
          <div className="header-search">
            <input 
              type="text" 
              placeholder="Quick search transaction or address..." 
              className="header-search-input"
              value={txHash}
              onChange={e => setTxHash(e.target.value)}
              onKeyPress={e => e.key === 'Enter' && fetchTx()}
            />
            <button 
              onClick={fetchTx} 
              disabled={txLoading}
              className="header-search-btn"
            >
              {txLoading ? '⏳' : '🔍'}
            </button>
          </div>
        </div>
      </header>

      {/* Main Layout */}
      <div className="ct-layout">
        {currentPage === 'prices' ? (
          <LivePrices apiBase={apiBase} />
        ) : (
          <>
            <main className="ct-main">
            {/* Transaction Details Section */}
            <section className="section-card">
              <div className="section-header">
                <h2>Transaction Details</h2>
                {txData && !txData.error && (
                  <div className="button-group">
                    <button onClick={analyzeTx} disabled={!txData || analysisLoading} className="btn-secondary">
                      Quick Analyze
                    </button>
                    <button 
                      onClick={() => analyzeWithLLM(txData)} 
                      disabled={!txData || analysisLoading} 
                      className="btn-primary"
                      title="Run AI-powered analysis using Gemini"
                    >
                      {analysisLoading ? '⏳ Analyzing...' : '✨ AI Analyze'}
                    </button>
                  </div>
                )}
              </div>

              {txLoading ? (
                <div className="panel loading-panel">
                  <div className="skeleton skeleton-line" style={{ width: '70%' }} />
                  <div className="skeleton skeleton-line" style={{ width: '50%' }} />
                  <div className="skeleton skeleton-line" style={{ width: '60%' }} />
                  <div className="skeleton skeleton-line" style={{ width: '40%' }} />
                  <div className="skeleton skeleton-line" style={{ width: '30%' }} />
                </div>
              ) : txData && txData.error ? (
                <div className="error-panel">
                  <div className="error-icon">⚠️</div>
                  <div className="error-content">
                    <div className="error-title">Failed to load transaction</div>
                    <div className="error-message">{txData.error}</div>
                    <button onClick={fetchTx} className="btn-retry">Try Again</button>
                  </div>
                </div>
              ) : txData ? (
                <div className="tx-details-panel">
                  <div className="tx-row">
                    <span className="tx-label">Transaction Hash</span>
                    <span className="tx-value tx-hash">
                      {txData.txHash || txData.hash}
                      <button 
                        onClick={() => navigator.clipboard?.writeText(txData.txHash || txData.hash)} 
                        className="btn-icon"
                        title="Copy to clipboard"
                      >
                        📋
                      </button>
                    </span>
                  </div>
                  <div className="tx-row">
                    <span className="tx-label">From</span>
                    <span className="tx-value tx-address">{txData.from || '—'}</span>
                  </div>
                  <div className="tx-row">
                    <span className="tx-label">To</span>
                    <span className="tx-value tx-address">{txData.to || '—'}</span>
                  </div>
                  <div className="tx-row">
                    <span className="tx-label">Value</span>
                    <span className="tx-value tx-amount">
                      {txData.value ? formatEth(txData.value) : (txData.valueUSD ?? '—')} {txData.tokenSymbol || ''}
                    </span>
                  </div>
                  <div className="tx-row">
                    <span className="tx-label">Block</span>
                    <span className="tx-value">{txData.blockNumber ?? '—'}</span>
                  </div>
                  <div className="tx-row">
                    <span className="tx-label">Timestamp</span>
                    <span className="tx-value">{txData.timestamp ?? txData.fetchedAt ?? '—'}</span>
                  </div>
                  <div className="tx-row">
                    <span className="tx-label">Gas Used</span>
                    <span className="tx-value">{txData.gasUsed ?? '—'}</span>
                  </div>
                  <div className="tx-row">
                    <span className="tx-label">Gas Price</span>
                    <span className="tx-value">
                      {txData.gasPriceGwei ? formatGwei(txData.gasPriceGwei) : (txData.gasPrice ? formatGwei(txData.gasPrice) : '—')}
                    </span>
                  </div>

                  <div className="tx-actions">
                    <button onClick={exportCsv} className="btn-secondary">📥 Export CSV</button>
                    <button 
                      onClick={() => { setAnalysis(null); setTimeout(() => analyzeTx(), 120) }}
                      className="btn-secondary"
                    >
                      🔄 Retry Analysis
                    </button>
                  </div>

                  <details className="tx-raw">
                    <summary>View Raw JSON</summary>
                    <pre>{formatJson(txData)}</pre>
                  </details>
                </div>
              ) : (
                <div className="empty-state">
                  <div className="empty-icon">🔍</div>
                  <div className="empty-title">No transaction loaded</div>
                  <div className="empty-message">Enter a transaction hash above to get started</div>
                </div>
              )}
            </section>

            {/* Address Lookup Section */}
            <section className="section-card">
              <div className="section-header">
                <h2>Address Transactions</h2>
              </div>

              <div className="address-lookup">
                <input 
                  placeholder="Enter Ethereum address..." 
                  value={addr} 
                  onChange={e => setAddr(e.target.value)} 
                  onKeyPress={e => e.key === 'Enter' && fetchAddressTxs()}
                  className="address-input"
                />
                <button onClick={fetchAddressTxs} className="btn-primary" disabled={addrLoading}>
                  {addrLoading ? 'Loading...' : 'Get Transactions'}
                </button>
              </div>

              {addrError && (
                <div className="error-banner">{addrError}</div>
              )}

              {addrLoading ? (
                <div className="loading-table">
                  {Array.from({length: pageSize}).map((_,i) => (
                    <div key={i} className="skeleton-row">
                      <div className="skeleton skeleton-cell" />
                      <div className="skeleton skeleton-cell" />
                      <div className="skeleton skeleton-cell" />
                      <div className="skeleton skeleton-cell" />
                    </div>
                  ))}
                </div>
              ) : !addrTxs ? (
                <div className="empty-state">
                  <div className="empty-icon">🏠</div>
                  <div className="empty-title">No address data</div>
                  <div className="empty-message">Enter an address above to view its transactions</div>
                </div>
              ) : (
                <div className="address-results">
                  <div className="results-header">
                    <div className="results-info">
                      <strong>{addrTxs.length}</strong> transactions found
                    </div>
                    <div className="results-actions">
                      <button onClick={() => exportAddrCsv(true)} className="btn-secondary">📥 Export Page</button>
                      <button onClick={() => exportAddrCsv(false)} className="btn-secondary">📥 Export All</button>
                    </div>
                  </div>

                  <div className="tx-table-container">
                    <table className="tx-table">
                      <thead>
                        <tr>
                          <th>Hash</th>
                          <th>From</th>
                          <th>To</th>
                          <th>Value (ETH)</th>
                          <th>Block</th>
                          <th>Timestamp</th>
                          <th>Gas Price</th>
                          <th>Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(addrTxs || []).slice((addrPage - 1) * pageSize, addrPage * pageSize).map(tx => (
                          <tr key={tx.txHash} onClick={() => onTxRowClick(tx)} className="tx-table-row">
                            <td className="tx-hash-cell">{tx.txHash ? `${tx.txHash.slice(0,10)}...${tx.txHash.slice(-6)}` : '—'}</td>
                            <td className="address-cell">{tx.from ? `${tx.from.slice(0,8)}...${tx.from.slice(-4)}` : '—'}</td>
                            <td className="address-cell">{tx.to ? `${tx.to.slice(0,8)}...${tx.to.slice(-4)}` : '—'}</td>
                            <td className="amount-cell">{tx.value != null ? Number(tx.value).toFixed(6) : '—'}</td>
                            <td>{tx.blockNumber ?? '—'}</td>
                            <td className="timestamp-cell">{tx.timestamp ? tx.timestamp.replace('T',' ').replace('.000Z','') : '—'}</td>
                            <td>{tx.gasPriceGwei != null ? tx.gasPriceGwei.toFixed(3) : '—'}</td>
                            <td className="error-cell">{tx.isError ? '❌' : '✓'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="pagination">
                    <button 
                      onClick={() => setAddrPage(Math.max(1, addrPage - 1))} 
                      disabled={addrPage <= 1}
                      className="btn-secondary"
                    >
                      ← Previous
                    </button>
                    <span className="pagination-info">
                      Page {addrPage} of {Math.max(1, Math.ceil((addrTxs.length || 0) / pageSize))}
                    </span>
                    <button 
                      onClick={() => setAddrPage(Math.min(Math.ceil(addrTxs.length / pageSize), addrPage + 1))} 
                      disabled={addrPage >= Math.ceil(addrTxs.length / pageSize)}
                      className="btn-secondary"
                    >
                      Next →
                    </button>
                  </div>
                </div>
              )}
            </section>
          </main>

          {/* Sidebar - AI Analysis */}
          <aside className="ct-aside">
            <div className="analysis-panel">
              <h3>AI Analysis</h3>
              
              {analysisLoading ? (
                <div className="loading-analysis">
                  <div className="skeleton" style={{ height: 12, width: '60%', marginBottom: 8 }} />
                  <div className="skeleton" style={{ height: 12, width: '40%', marginBottom: 8 }} />
                  <div className="skeleton" style={{ height: 12, width: '80%', marginBottom: 8 }} />
                </div>
              ) : analysis && analysis.error ? (
                <div className="analysis-error">
                  <div className="error-icon">⚠️</div>
                  <div className="error-message">{analysis.error}</div>
                </div>
              ) : analysis ? (
                <div className="analysis-content">
                  <div className="analysis-summary">
                    <div className="analysis-label">Summary</div>
                    <p>{analysis.nlpSummary || analysis.summary || 'No summary available'}</p>
                  </div>

                  <div className="analysis-anomaly">
                    <div className="analysis-label">Anomaly Detection</div>
                    <div className="anomaly-score-bar">
                      <div 
                        className="anomaly-score-fill" 
                        style={{ 
                          width: `${Math.min(100, ((analysis?.anomaly?.score ?? analysis?.score ?? 0) * 100))}%`,
                          background: (analysis?.anomaly?.score ?? analysis?.score ?? 0) > 0.5 ? '#d9534f' : '#5cb85c'
                        }} 
                      />
                    </div>
                    <div className="anomaly-details">
                      <span className="anomaly-percentage">{((analysis?.anomaly?.score ?? analysis?.score ?? 0) * 100).toFixed(1)}%</span>
                      <span 
                        className="anomaly-badge" 
                        style={anomalyBadge(analysis?.anomaly?.label ?? analysis?.label ?? '')}
                      >
                        {analysis?.anomaly?.label ?? analysis?.label ?? 'unknown'}
                      </span>
                    </div>
                  </div>

                  {analysis?.feePrediction && (
                    <div className="analysis-fee">
                      <div className="analysis-label">Predicted Fee</div>
                      <div className="analysis-value">{analysis.feePrediction}</div>
                    </div>
                  )}

                  {analysis?.llm && (
                    <div className="llm-badge">
                      ✨ Enhanced with AI
                    </div>
                  )}

                  <details className="analysis-raw">
                    <summary>View Full Response</summary>
                    <pre>{formatJson(analysis)}</pre>
                  </details>
                </div>
              ) : (
                <div className="empty-analysis">
                  <div className="empty-icon">🤖</div>
                  <div className="empty-message">No analysis yet. Load a transaction and click "AI Analyze"</div>
                </div>
              )}
            </div>
          </aside>
          </>
        )}
      </div>
    </div>
  )
}
