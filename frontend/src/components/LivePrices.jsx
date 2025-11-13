import React, { useState, useEffect } from 'react'

export default function LivePrices({ apiBase }) {
  const [prices, setPrices] = useState({})
  const [loading, setLoading] = useState({})
  const [error, setError] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  // Popular cryptocurrencies to track
  const cryptos = [
    { id: 'bitcoin', name: 'Bitcoin', symbol: 'BTC', color: '#f7931a' },
    { id: 'ethereum', name: 'Ethereum', symbol: 'ETH', color: '#627eea' },
    { id: 'binancecoin', name: 'BNB', symbol: 'BNB', color: '#f3ba2f' },
    { id: 'ripple', name: 'Ripple', symbol: 'XRP', color: '#23292f' },
    { id: 'cardano', name: 'Cardano', symbol: 'ADA', color: '#0033ad' },
    { id: 'solana', name: 'Solana', symbol: 'SOL', color: '#14f195' },
    { id: 'polkadot', name: 'Polkadot', symbol: 'DOT', color: '#e6007a' },
    { id: 'dogecoin', name: 'Dogecoin', symbol: 'DOGE', color: '#c2a633' },
  ]

  useEffect(() => {
    fetchAllPrices()
    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchAllPrices, 30000)
    return () => clearInterval(interval)
  }, [])

  async function fetchAllPrices() {
    setRefreshing(true)
    for (const crypto of cryptos) {
      await fetchPrice(crypto.id)
    }
    setRefreshing(false)
  }

  async function fetchPrice(symbol) {
    setLoading(prev => ({ ...prev, [symbol]: true }))
    try {
      const r = await fetch(`${apiBase}/api/price/${symbol}`)
      const data = await r.json()
      setPrices(prev => ({ ...prev, [symbol]: data }))
      setError(null)
    } catch (err) {
      setError(err.toString())
    } finally {
      setLoading(prev => ({ ...prev, [symbol]: false }))
    }
  }

  function formatPrice(price) {
    if (!price) return '—'
    if (price >= 1000) return `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    if (price >= 1) return `$${price.toFixed(4)}`
    return `$${price.toFixed(6)}`
  }

  function formatChange(change) {
    if (!change) return null
    const isPositive = change > 0
    return (
      <span className={isPositive ? 'price-change-positive' : 'price-change-negative'}>
        {isPositive ? '▲' : '▼'} {Math.abs(change).toFixed(2)}%
      </span>
    )
  }

  return (
    <div className="live-prices-container">
      <div className="prices-header">
        <div>
          <h2>Live Cryptocurrency Prices</h2>
          <p className="prices-subtitle">Real-time data from CoinGecko • Updates every 30s</p>
        </div>
        <button 
          onClick={fetchAllPrices} 
          disabled={refreshing}
          className="btn-primary"
        >
          {refreshing ? '🔄 Refreshing...' : '🔄 Refresh Prices'}
        </button>
      </div>

      {error && (
        <div className="error-banner">
          Failed to fetch prices: {error}
        </div>
      )}

      <div className="price-grid">
        {cryptos.map(crypto => {
          const priceData = prices[crypto.id]?.[crypto.id]
          const isLoading = loading[crypto.id]

          return (
            <div key={crypto.id} className="price-card">
              <div className="price-card-header">
                <div className="crypto-info">
                  <div 
                    className="crypto-icon" 
                    style={{ background: crypto.color }}
                  >
                    {crypto.symbol.charAt(0)}
                  </div>
                  <div>
                    <div className="crypto-name">{crypto.name}</div>
                    <div className="crypto-symbol">{crypto.symbol}</div>
                  </div>
                </div>
                {isLoading && <div className="loading-spinner">⏳</div>}
              </div>

              {isLoading && !priceData ? (
                <div className="price-skeleton">
                  <div className="skeleton skeleton-line" style={{ width: '60%' }} />
                  <div className="skeleton skeleton-line" style={{ width: '40%' }} />
                </div>
              ) : priceData ? (
                <div className="price-details">
                  <div className="current-price">
                    {formatPrice(priceData.usd)}
                  </div>
                  <div className="price-changes">
                    {priceData.usd_24h_change && formatChange(priceData.usd_24h_change)}
                  </div>
                  {priceData.usd_market_cap && (
                    <div className="market-cap">
                      Market Cap: ${(priceData.usd_market_cap / 1e9).toFixed(2)}B
                    </div>
                  )}
                  {priceData.usd_24h_vol && (
                    <div className="volume">
                      24h Vol: ${(priceData.usd_24h_vol / 1e6).toFixed(2)}M
                    </div>
                  )}
                </div>
              ) : (
                <div className="price-empty">
                  <button 
                    onClick={() => fetchPrice(crypto.id)} 
                    className="btn-secondary"
                  >
                    Load Price
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="prices-footer">
        <p>💡 Tip: Prices are cached for 60 seconds to avoid API rate limits</p>
      </div>
    </div>
  )
}
