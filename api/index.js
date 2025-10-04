const axios = require('axios');

const API_CONFIG = {
    marketKit: {
        baseUrl: 'https://api.horizontalsystems.xyz/v1',
        apiKey: process.env.MARKETKIT_API_KEY
    },
    blockchain: {
        eth: {
            rpc: 'https://cloudflare-eth.com'
        },
        bsc: {
            rpc: 'https://bsc-dataseed.binance.org'
        },
        polygon: {
            rpc: 'https://polygon-rpc.com'
        },
        avalanche: {
            rpc: 'https://api.avax.network/ext/bc/C/rpc'
        },
        optimism: {
            rpc: 'https://mainnet.optimism.io'
        },
        arbitrum: {
            rpc: 'https://arb1.arbitrum.io/rpc'
        }
    }
};

/**
 * Main handler for the Edge Function.
 */
module.exports = async (req, res) => {
    const { path, query, body } = req;

    try {
        if (path.startsWith('/api/v1/market/overview')) {
            const response = await handleMarketOverview();
            res.status(response.statusCode).json(JSON.parse(response.body));
            return;
        }

        const coinDetailsMatch = path.match(/^\/api\/v1\/coins\/(.+)\/details$/);
        if (coinDetailsMatch && coinDetailsMatch[1]) {
            const coinUid = coinDetailsMatch[1];
            const response = await handleCoinDetails(coinUid);
            res.status(response.statusCode).json(JSON.parse(response.body));
            return;
        } else if (path.startsWith('/api/v1/addresses')) {
            const event = { path, queryString: query, body };
            const response = await handleAddresses(event);
            res.status(response.statusCode).json(JSON.parse(response.body));
            return;
        }

        res.status(404).json({ error: 'Not Found' });

    } catch (error) {
        console.error('Unhandled error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

/**
 * Handles the /market/overview endpoint.
 */
async function handleMarketOverview() {
    const [topCoinsResult, topMoversResult] = await Promise.allSettled([
        axios.get(`${API_CONFIG.marketKit.baseUrl}/markets/overview?currency=usd`, { headers: { 'api_key': API_CONFIG.marketKit.apiKey } }),
        axios.get(`${API_CONFIG.marketKit.baseUrl}/coins/top-movers?currency=usd`, { headers: { 'api_key': API_CONFIG.marketKit.apiKey } })
    ]);

    const topCoins = topCoinsResult.status === 'fulfilled' ? topCoinsResult.value.data.map(c => ({ uid: c.uid, name: c.name, code: c.code, price: c.price, price_change_24h: c.price_change_24h })) : [];
    const topMovers = topMoversResult.status === 'fulfilled' ? topMoversResult.value.data : { gainers: [], losers: [] };

    const responseData = {
        topCoins: topCoins.slice(0, 100),
        topMovers
    };

    return createResponse(200, responseData);
}

/**
 * Handles the /coins/{coinUid}/details endpoint.
 * @param {string} coinUid - The unique ID of the coin.
 */
async function handleCoinDetails(coinUid) {
    const endpoints = {
        info: `${API_CONFIG.marketKit.baseUrl}/coins/${coinUid}?currency=usd`,
        chart: `${API_CONFIG.marketKit.baseUrl}/charts?coin_uid=${coinUid}&currency=usd&interval=1d`,
        tickers: `${API_CONFIG.marketKit.baseUrl}/coins/${coinUid}/tickers?currency=usd`
    };

    const [infoResult, chartResult, tickersResult] = await Promise.allSettled([
        axios.get(endpoints.info, { headers: { 'api_key': API_CONFIG.marketKit.apiKey } }),
        axios.get(endpoints.chart, { headers: { 'api_key': API_CONFIG.marketKit.apiKey } }),
        axios.get(endpoints.tickers, { headers: { 'api_key': API_CONFIG.marketKit.apiKey } })
    ]);

    const responseData = {
        info: infoResult.status === 'fulfilled' ? infoResult.value.data.meta : null,
        marketData: infoResult.status === 'fulfilled' ? infoResult.value.data.market_data : null,
        chartData: chartResult.status === 'fulfilled' ? chartResult.value.data.map(p => [p.timestamp, p.price]) : null,
        tickers: tickersResult.status === 'fulfilled' ? tickersResult.value.data.tickers.map(t => ({ exchangeName: t.market_name, pair: `${t.base}/${t.target}`, volume: t.volume })) : null
    };

    return createResponse(200, responseData);
}

/**
 * Handles blockchain-related requests for addresses.
 * @param {object} event - The event object from the Edge Function.
 */
async function handleAddresses(event) {
    const path = event.path;
    const parts = path.split('/');
    // Expected path: /api/v1/addresses/{address}/{action}?blockchain={chain}
    if (parts.length < 6) {
        return createResponse(400, { error: 'Invalid address request' });
    }
    const address = parts[4];
    const action = parts[5];

    const blockchain = event.queryString && event.queryString.blockchain ? event.queryString.blockchain : 'eth';

    const rpcUrl = API_CONFIG.blockchain[blockchain] ? API_CONFIG.blockchain[blockchain].rpc : null;

    if (!rpcUrl) {
        return createResponse(400, { error: `Unsupported blockchain: ${blockchain}` });
    }

    try {
        let result;
        switch (action) {
            case 'balance':
                result = await getBalance(rpcUrl, address);
                break;
            case 'broadcast':
                const rawTx = event.body; // Assuming the raw tx is in the body
                if (!rawTx) {
                    return createResponse(400, { error: 'Missing raw transaction in body' });
                }
                result = await broadcastTransaction(rpcUrl, rawTx);
                break;
            default:
                return createResponse(400, { error: `Invalid action: ${action}` });
        }
        return createResponse(200, result);
    } catch (error) {
        console.error(`RPC error for ${blockchain}:`, error.message);
        return createResponse(500, { error: 'Blockchain RPC request failed' });
    }
}

async function getBalance(rpcUrl, address) {
    const rpcRequest = createRpcRequest('eth_getBalance', [address, 'latest']);
    const response = await axios.post(rpcUrl, rpcRequest);
    return response.data;
}

async function broadcastTransaction(rpcUrl, rawTx) {
    const rpcRequest = createRpcRequest('eth_sendRawTransaction', [rawTx]);
    const response = await axios.post(rpcUrl, rpcRequest);
    return response.data;
}

function createRpcRequest(method, params) {
    return {
        jsonrpc: '2.0',
        id: 1,
        method: method,
        params: params,
    };
}

/**
 * Creates a structured HTTP response for Tencent EdgeOne.
 * @param {number} statusCode - The HTTP status code.
 * @param {object} body - The JSON response body.
 */
function createResponse(statusCode, body) {
    return {
        isBase64Encoded: false,
        statusCode: statusCode,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
    };
}
