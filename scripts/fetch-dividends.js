const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// ============== 配置 ==============
const CONFIG = {
  BATCH_SIZE: 3,              // 降低并发数
  MIN_DELAY: 500,             // 提高最小延迟
  MAX_DELAY: 1500,            // 提高最大延迟
  BATCH_DELAY: 2000,          // 每批之间额外延迟
  RETRY_TIMES: 5,             // 增加重试次数
  RETRY_DELAY: 3000,          // 重试延迟
  TIMEOUT: 15000,             // 请求超时
  SAVE_INTERVAL: 100,         // 更频繁保存进度
  FILTER_NA: false,
  
  // 限流保护
  RATE_LIMIT_PAUSE: 30000,    // 被限流后暂停 30 秒
  ERROR_PAUSE: 10000,         // 出错后暂停 10 秒
  MAX_CONSECUTIVE_ERRORS: 10, // 连续错误超过此数暂停更久
  LONG_PAUSE: 60000,          // 长暂停 60 秒
};

// ============== User-Agent 池（更多选择）==============
const USER_AGENTS = [
  // Chrome Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  // Chrome Mac
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  // Safari
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  // Firefox
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:122.0) Gecko/20100101 Firefox/122.0',
  // Edge
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
];

// ============== 状态跟踪 ==============
let currentUAIndex = 0;
let consecutiveErrors = 0;
let totalRequests = 0;
let successRequests = 0;
let failedRequests = 0;

// 轮换 User-Agent（而不是随机，避免重复）
const getNextUA = () => {
  currentUAIndex = (currentUAIndex + 1) % USER_AGENTS.length;
  return USER_AGENTS[currentUAIndex];
};

// 获取请求头（更完整的浏览器模拟）
const getHeaders = () => {
  const ua = getNextUA();
  const isChrome = ua.includes('Chrome');
  const isFirefox = ua.includes('Firefox');
  const isSafari = ua.includes('Safari') && !ua.includes('Chrome');
  
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://www.nasdaq.com',
    'Referer': 'https://www.nasdaq.com/market-activity/stocks',
    'User-Agent': ua,
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
  };
  
  // Chrome 特有头
  if (isChrome) {
    headers['sec-ch-ua'] = '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"';
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = '"Windows"';
  }
  
  return headers;
};

// ============== 路径设置 ==============
const DATA_DIR = path.join(__dirname, '../data');
const OUTPUT_FILE = path.join(DATA_DIR, 'dividends.json');
const PROGRESS_FILE = path.join(DATA_DIR, '.progress.json');
const PARTIAL_FILE = path.join(DATA_DIR, '.partial_stocks.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ============== 工具函数 ==============

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const randomDelay = (min = CONFIG.MIN_DELAY, max = CONFIG.MAX_DELAY) => {
  const ms = min + Math.random() * (max - min);
  return delay(ms);
};

// 解析收入字符串
function parseRevenue(str) {
  if (!str) return null;
  const cleaned = str.replace(/[$,]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// 智能暂停（根据错误情况调整）
async function smartPause(reason) {
  consecutiveErrors++;
  
  if (consecutiveErrors >= CONFIG.MAX_CONSECUTIVE_ERRORS) {
    console.log(`\n⚠️ 连续 ${consecutiveErrors} 次错误，长暂停 ${CONFIG.LONG_PAUSE/1000} 秒...`);
    await delay(CONFIG.LONG_PAUSE);
    consecutiveErrors = 0; // 重置
  } else if (reason === 'rate_limit') {
    console.log(`\n⚠️ 被限流，暂停 ${CONFIG.RATE_LIMIT_PAUSE/1000} 秒...`);
    await delay(CONFIG.RATE_LIMIT_PAUSE);
  } else {
    await delay(CONFIG.ERROR_PAUSE);
  }
}

// 带重试的 fetch（增强版）
async function fetchWithRetry(url, retries = CONFIG.RETRY_TIMES) {
  totalRequests++;
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // 每次重试前等待
      if (attempt > 0) {
        const waitTime = CONFIG.RETRY_DELAY * Math.pow(1.5, attempt); // 指数退避
        await delay(waitTime);
      }
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.TIMEOUT);
      
      const res = await fetch(url, {
        headers: getHeaders(),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      // 处理各种状态码
      if (res.status === 429) {
        console.log(`\n🚫 429 Too Many Requests`);
        await smartPause('rate_limit');
        continue;
      }
      
      if (res.status === 403) {
        console.log(`\n🚫 403 Forbidden`);
        await smartPause('forbidden');
        continue;
      }
      
      if (res.status === 503 || res.status === 502) {
        console.log(`\n🚫 ${res.status} Server Error`);
        await smartPause('server_error');
        continue;
      }
      
      if (!res.ok) {
        failedRequests++;
        return null;
      }
      
      // 成功
      consecutiveErrors = 0; // 重置错误计数
      successRequests++;
      return await res.json();
      
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log(`\n⏱️ 请求超时: ${url.split('/').pop()}`);
      }
      
      if (attempt === retries) {
        failedRequests++;
        return null;
      }
    }
  }
  
  failedRequests++;
  return null;
}

// 保存进度
function saveProgress(dividendStocks, processedSymbols, errors) {
  const progress = {
    timestamp: new Date().toISOString(),
    processedCount: processedSymbols.size,
    foundCount: dividendStocks.length,
    errorCount: errors.length,
    processedSymbols: Array.from(processedSymbols),
  };
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));
  
  // 同时保存已找到的股票数据
  if (dividendStocks.length > 0) {
    fs.writeFileSync(PARTIAL_FILE, JSON.stringify(dividendStocks));
  }
}

// 加载进度
function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
      const age = Date.now() - new Date(data.timestamp).getTime();
      if (age < 4 * 60 * 60 * 1000) { // 4小时内的进度
        console.log(`📂 恢复进度: 已处理 ${data.processedCount} 条，找到 ${data.foundCount} 条`);
        return {
          processedSymbols: new Set(data.processedSymbols),
          partialStocks: fs.existsSync(PARTIAL_FILE) 
            ? JSON.parse(fs.readFileSync(PARTIAL_FILE, 'utf-8'))
            : [],
        };
      }
    }
  } catch (e) {}
  return { processedSymbols: new Set(), partialStocks: [] };
}

// 清除进度文件
function clearProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
    if (fs.existsSync(PARTIAL_FILE)) fs.unlinkSync(PARTIAL_FILE);
  } catch (e) {}
}

// ============== 数据获取函数 ==============

// 获取增长率数据（带保护）
async function fetchGrowthRate(symbol) {
  let growthRate = '';
  let growthSource = '';

  // 随机延迟，避免请求过快
  await randomDelay(200, 500);

  // 来源1: PEG Ratio API
  try {
    const pegJson = await fetchWithRetry(
      `https://api.nasdaq.com/api/analyst/${symbol}/peg-ratio`
    );
    
    if (pegJson?.data) {
      const growthData = pegJson.data.gr?.peGrowthChart?.find(
        item => item.z === 'Growth'
      );
      if (growthData?.y && growthData.y !== 0) {
        growthRate = `${growthData.y}%`;
        growthSource = 'Analyst Forecast';
      }
    }
  } catch {}

  // 来源2: 财务数据
  if (!growthRate) {
    await randomDelay(200, 500);
    
    try {
      const finJson = await fetchWithRetry(
        `https://api.nasdaq.com/api/company/${symbol}/financials?frequency=1`
      );
      
      if (finJson?.data) {
        const rows = finJson.data.incomeStatementTable?.rows || [];
        const revenueRow = rows.find(r => 
          r.value1?.toLowerCase().includes('total revenue')
        );
        
        if (revenueRow) {
          const latestRevenue = parseRevenue(revenueRow.value2);
          const oldestRevenue = parseRevenue(revenueRow.value5);
          
          if (latestRevenue && oldestRevenue && oldestRevenue !== 0) {
            const cagr = (Math.pow(latestRevenue / oldestRevenue, 1/4) - 1) * 100;
            growthRate = `${cagr.toFixed(1)}%`;
            growthSource = '4yr Revenue CAGR';
          }
        }
      }
    } catch {}
  }

  return { growthRate, growthSource };
}

// 获取单只股票信息（串行请求，更安全）
async function fetchStockData(stock) {
  try {
    // 1. 获取股息信息
    const divJson = await fetchWithRetry(
      `https://api.nasdaq.com/api/quote/${stock.symbol}/dividends?assetclass=stocks`
    );
    
    if (!divJson?.data) return null;
    
    const divData = divJson.data;
    const yieldStr = divData.yield;
    const annualDiv = divData.annualizedDividend;
    
    if (
      !yieldStr || !annualDiv ||
      yieldStr === 'N/A' || yieldStr === '--' ||
      annualDiv === 'N/A' || annualDiv === '0' ||
      parseFloat(yieldStr) <= 0
    ) {
      return null;
    }

    // 2. 延迟后获取公司简介
    await randomDelay(300, 800);
    
    let description = '';
    let sector = stock.sector || '';
    let industry = stock.industry || '';
    
    const profileJson = await fetchWithRetry(
      `https://api.nasdaq.com/api/company/${stock.symbol}/company-profile`
    );
    
    if (profileJson?.data) {
      description = profileJson.data.CompanyDescription?.value || '';
      sector = profileJson.data.Sector?.value || sector;
      industry = profileJson.data.Industry?.value || industry;
    }

    // 3. 获取增长率
    const growthData = await fetchGrowthRate(stock.symbol);

    return {
      symbol: stock.symbol,
      name: stock.name,
      price: stock.lastsale,
      marketCap: stock.marketCap,
      sector,
      industry,
      dividendYield: yieldStr,
      annualDividend: `$${annualDiv}`,
      exDividendDate: divData.exDividendDate || '',
      paymentDate: divData.dividendPaymentDate || '',
      growthRate: growthData.growthRate || 'N/A',
      growthSource: growthData.growthSource || '',
      description,
    };
  } catch (error) {
    return null;
  }
}

// ============== 统计函数 ==============

function getSectorStats(stocks) {
  const stats = {};
  stocks.forEach(s => {
    const sector = s.sector || 'Unknown';
    if (!stats[sector]) {
      stats[sector] = { count: 0, avgYield: 0, totalYield: 0 };
    }
    stats[sector].count++;
    stats[sector].totalYield += parseFloat(s.dividendYield) || 0;
  });
  
  Object.keys(stats).forEach(sector => {
    stats[sector].avgYield = (stats[sector].totalYield / stats[sector].count).toFixed(2) + '%';
    delete stats[sector].totalYield;
  });
  
  return stats;
}

function getYieldRanges(stocks) {
  const ranges = {
    '0-2%': 0, '2-4%': 0, '4-6%': 0,
    '6-8%': 0, '8-10%': 0, '10%+': 0,
  };
  
  stocks.forEach(s => {
    const y = parseFloat(s.dividendYield) || 0;
    if (y < 2) ranges['0-2%']++;
    else if (y < 4) ranges['2-4%']++;
    else if (y < 6) ranges['4-6%']++;
    else if (y < 8) ranges['6-8%']++;
    else if (y < 10) ranges['8-10%']++;
    else ranges['10%+']++;
  });
  
  return ranges;
}

function getGrowthStats(stocks) {
  const withGrowth = stocks.filter(s => s.growthRate !== 'N/A');
  const withoutGrowth = stocks.filter(s => s.growthRate === 'N/A');
  
  const sourceStats = {};
  withGrowth.forEach(s => {
    const source = s.growthSource || 'Unknown';
    sourceStats[source] = (sourceStats[source] || 0) + 1;
  });

  const growthRanges = {
    'negative': 0, '0-5%': 0, '5-10%': 0, '10-20%': 0, '20%+': 0,
  };
  
  withGrowth.forEach(s => {
    const g = parseFloat(s.growthRate) || 0;
    if (g < 0) growthRanges['negative']++;
    else if (g < 5) growthRanges['0-5%']++;
    else if (g < 10) growthRanges['5-10%']++;
    else if (g < 20) growthRanges['10-20%']++;
    else growthRanges['20%+']++;
  });

  return {
    withGrowthData: withGrowth.length,
    withoutGrowthData: withoutGrowth.length,
    coveragePercent: stocks.length > 0 
      ? ((withGrowth.length / stocks.length) * 100).toFixed(1) + '%' 
      : '0%',
    bySource: sourceStats,
    byRange: growthRanges,
  };
}

// ============== 主函数 ==============

async function fetchDividendStocks() {
  const startTime = Date.now();
  console.log('🚀 开始获取股票数据（安全模式）...');
  console.log(`⏰ 开始时间: ${new Date().toISOString()}`);
  console.log(`⚙️ 配置: 并发=${CONFIG.BATCH_SIZE} | 延迟=${CONFIG.MIN_DELAY}-${CONFIG.MAX_DELAY}ms`);
  console.log(`🛡️ 保护: 限流暂停=${CONFIG.RATE_LIMIT_PAUSE/1000}s | 长暂停=${CONFIG.LONG_PAUSE/1000}s`);
  
  try {
    // 1. 获取股票列表
    console.log('\n📊 获取股票列表...');
    const screenerData = await fetchWithRetry(
      'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000'
    );
    
    const allStocks = screenerData?.data?.table?.rows || [];
    console.log(`✅ 共找到 ${allStocks.length} 只股票`);
    
    if (allStocks.length === 0) {
      throw new Error('无法获取股票列表');
    }

    // 2. 加载进度
    const { processedSymbols, partialStocks } = loadProgress();
    const dividendStocks = [...partialStocks];
    const errors = [];
    
    const remainingStocks = allStocks.filter(s => !processedSymbols.has(s.symbol));
    console.log(`📝 待处理: ${remainingStocks.length} 只 | 已处理: ${processedSymbols.size} 只 | 已找到: ${dividendStocks.length} 只`);
    
    // 3. 逐个处理（更安全）
    console.log('\n💰 开始获取股息数据...\n');
    
    for (let i = 0; i < remainingStocks.length; i++) {
      const stock = remainingStocks[i];
      
      // 获取股票数据
      const result = await fetchStockData(stock);
      
      processedSymbols.add(stock.symbol);
      if (result) {
        dividendStocks.push(result);
      }
      
      // 显示进度
      const totalProcessed = processedSymbols.size;
      const percent = ((totalProcessed / allStocks.length) * 100).toFixed(1);
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      const withGrowth = dividendStocks.filter(s => s.growthRate !== 'N/A').length;
      const successRate = totalRequests > 0 
        ? ((successRequests / totalRequests) * 100).toFixed(0) 
        : 100;
      
      process.stdout.write(
        `\r📈 ${totalProcessed}/${allStocks.length} (${percent}%) | ` +
        `股息: ${dividendStocks.length} | ` +
        `增长率: ${withGrowth} | ` +
        `成功率: ${successRate}% | ` +
        `${elapsed}分钟`
      );
      
      // 保存进度
      if (totalProcessed % CONFIG.SAVE_INTERVAL === 0) {
        saveProgress(dividendStocks, processedSymbols, errors);
      }
      
      // 每批之间额外延迟
      if ((i + 1) % CONFIG.BATCH_SIZE === 0) {
        await delay(CONFIG.BATCH_DELAY);
      } else {
        await randomDelay();
      }
    }

    console.log('\n');

    // 4. 排序
    dividendStocks.sort((a, b) => {
      const yA = parseFloat(a.dividendYield) || 0;
      const yB = parseFloat(b.dividendYield) || 0;
      return yB - yA;
    });

    // 5. 过滤
    const finalStocks = CONFIG.FILTER_NA 
      ? dividendStocks.filter(s => s.growthRate !== 'N/A')
      : dividendStocks;

    // 6. 统计
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000 / 60).toFixed(2);
    const growthStats = getGrowthStats(dividendStocks);
    
    const outputData = {
      lastUpdated: new Date().toISOString(),
      metadata: {
        totalScanned: allStocks.length,
        totalDividendStocks: dividendStocks.length,
        filteredCount: finalStocks.length,
        filterNA: CONFIG.FILTER_NA,
        durationMinutes: parseFloat(duration),
        requestStats: {
          total: totalRequests,
          success: successRequests,
          failed: failedRequests,
          successRate: `${((successRequests / totalRequests) * 100).toFixed(1)}%`,
        },
        generatedBy: 'GitHub Actions',
      },
      statistics: {
        growth: growthStats,
        bySector: getSectorStats(dividendStocks),
        yieldRanges: getYieldRanges(dividendStocks),
        top10ByYield: dividendStocks.slice(0, 10).map(s => ({
          symbol: s.symbol,
          name: s.name,
          yield: s.dividendYield,
          growthRate: s.growthRate,
          growthSource: s.growthSource,
        })),
        top10ByGrowth: dividendStocks
          .filter(s => s.growthRate !== 'N/A')
          .sort((a, b) => parseFloat(b.growthRate) - parseFloat(a.growthRate))
          .slice(0, 10)
          .map(s => ({
            symbol: s.symbol,
            name: s.name,
            yield: s.dividendYield,
            growthRate: s.growthRate,
            growthSource: s.growthSource,
          })),
      },
      stocks: finalStocks,
    };

    // 7. 保存
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(outputData, null, 2));
    clearProgress();
    
    // 8. 输出统计
    console.log('✅ 数据获取完成！');
    console.log('═'.repeat(60));
    console.log(`📁 文件: ${OUTPUT_FILE}`);
    console.log(`📊 扫描: ${allStocks.length} | 股息股: ${dividendStocks.length} | 输出: ${finalStocks.length}`);
    console.log(`📈 有增长率: ${growthStats.withGrowthData} (${growthStats.coveragePercent})`);
    console.log(`🌐 请求: 总计 ${totalRequests} | 成功 ${successRequests} | 失败 ${failedRequests}`);
    console.log(`⏱️ 耗时: ${duration} 分钟`);
    console.log('═'.repeat(60));

    return outputData;

  } catch (error) {
    console.error('\n❌ 致命错误:', error);
    process.exit(1);
  }
}

// ============== 执行 ==============
fetchDividendStocks();