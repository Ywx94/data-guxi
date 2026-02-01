const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// ============== 配置 ==============
const CONFIG = {
  BATCH_SIZE: 10,
  MIN_DELAY: 100,
  MAX_DELAY: 300,
  RETRY_TIMES: 3,
  RETRY_DELAY: 1000,
  TIMEOUT: 8000,
  SAVE_INTERVAL: 500,
  FILTER_NA: false,  // 是否过滤没有增长率的股票
};

// ============== User-Agent 池 ==============
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

const getRandomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const getHeaders = () => ({
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Origin': 'https://www.nasdaq.com',
  'Referer': 'https://www.nasdaq.com/',
  'User-Agent': getRandomUA(),
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
});

// ============== 路径设置 ==============
const DATA_DIR = path.join(__dirname, '../data');
const OUTPUT_FILE = path.join(DATA_DIR, 'dividends.json');
const PROGRESS_FILE = path.join(DATA_DIR, '.progress.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ============== 工具函数 ==============

const randomDelay = () => {
  const delay = CONFIG.MIN_DELAY + Math.random() * (CONFIG.MAX_DELAY - CONFIG.MIN_DELAY);
  return new Promise(resolve => setTimeout(resolve, delay));
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 解析收入字符串 "$416,161,000" -> 416161000
function parseRevenue(str) {
  if (!str) return null;
  const cleaned = str.replace(/[$,]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// 带重试的 fetch
async function fetchWithRetry(url, retries = CONFIG.RETRY_TIMES) {
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.TIMEOUT);
      
      const res = await fetch(url, {
        headers: getHeaders(),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (res.status === 429) {
        console.log(`\n⚠️ 请求被限流，等待 ${5 * (i + 1)} 秒...`);
        await delay(5000 * (i + 1));
        continue;
      }
      
      if (res.status === 403) {
        console.log(`\n⚠️ 请求被拒绝 (403)，等待 ${10 * (i + 1)} 秒...`);
        await delay(10000 * (i + 1));
        continue;
      }
      
      if (!res.ok) return null;
      
      return await res.json();
    } catch (error) {
      if (i < retries) {
        await delay(CONFIG.RETRY_DELAY * (i + 1));
      }
    }
  }
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
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// 加载进度
function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
      const age = Date.now() - new Date(data.timestamp).getTime();
      if (age < 2 * 60 * 60 * 1000) {
        console.log(`📂 发现之前的进度，已处理 ${data.processedCount} 条`);
        return new Set(data.processedSymbols);
      }
    }
  } catch (e) {}
  return new Set();
}

// 清除进度文件
function clearProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      fs.unlinkSync(PROGRESS_FILE);
    }
  } catch (e) {}
}

// ============== 数据获取函数 ==============

// 获取增长率数据
async function fetchGrowthRate(symbol) {
  let growthRate = '';
  let growthSource = '';

  // 来源1: PEG Ratio API（分析师预测）
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

  // 来源2: 如果没有，用财务数据计算历史增长率
  if (!growthRate) {
    try {
      const finJson = await fetchWithRetry(
        `https://api.nasdaq.com/api/company/${symbol}/financials?frequency=1`
      );
      
      if (finJson?.data) {
        const rows = finJson.data.incomeStatementTable?.rows || [];
        
        // 找到 Total Revenue 行
        const revenueRow = rows.find(r => 
          r.value1?.toLowerCase().includes('total revenue')
        );
        
        if (revenueRow) {
          // 解析收入数据 (value2 是最新, value5 是4年前)
          const latestRevenue = parseRevenue(revenueRow.value2);
          const oldestRevenue = parseRevenue(revenueRow.value5);
          
          if (latestRevenue && oldestRevenue && oldestRevenue !== 0) {
            // 计算年化增长率 (CAGR over 4 years)
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

// 获取单只股票的完整信息
async function fetchStockData(stock) {
  try {
    // 1. 获取股息信息（必须）
    const divJson = await fetchWithRetry(
      `https://api.nasdaq.com/api/quote/${stock.symbol}/dividends?assetclass=stocks`
    );
    
    if (!divJson?.data) return null;
    
    const divData = divJson.data;
    const yieldStr = divData.yield;
    const annualDiv = divData.annualizedDividend;
    
    // 过滤无效数据
    if (
      !yieldStr || !annualDiv ||
      yieldStr === 'N/A' || yieldStr === '--' ||
      annualDiv === 'N/A' || annualDiv === '0' ||
      parseFloat(yieldStr) <= 0
    ) {
      return null;
    }

    // 2. 并行获取公司简介和增长率
    const [profileJson, growthData] = await Promise.all([
      fetchWithRetry(`https://api.nasdaq.com/api/company/${stock.symbol}/company-profile`),
      fetchGrowthRate(stock.symbol),
    ]);

    // 解析公司信息
    let description = '';
    let sector = stock.sector || '';
    let industry = stock.industry || '';
    
    if (profileJson?.data) {
      description = profileJson.data.CompanyDescription?.value || '';
      sector = profileJson.data.Sector?.value || sector;
      industry = profileJson.data.Industry?.value || industry;
    }

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
  
  // 增长率来源统计
  const sourceStats = {};
  withGrowth.forEach(s => {
    const source = s.growthSource || 'Unknown';
    sourceStats[source] = (sourceStats[source] || 0) + 1;
  });

  // 增长率分布
  const growthRanges = {
    'negative': 0,
    '0-5%': 0,
    '5-10%': 0,
    '10-20%': 0,
    '20%+': 0,
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
    coveragePercent: ((withGrowth.length / stocks.length) * 100).toFixed(1) + '%',
    bySource: sourceStats,
    byRange: growthRanges,
  };
}

// ============== 主函数 ==============

async function fetchDividendStocks() {
  const startTime = Date.now();
  console.log('🚀 开始获取股票数据...');
  console.log(`⏰ 开始时间: ${new Date().toISOString()}`);
  console.log(`⚙️ 配置: 并发=${CONFIG.BATCH_SIZE} | 延迟=${CONFIG.MIN_DELAY}-${CONFIG.MAX_DELAY}ms | 过滤N/A=${CONFIG.FILTER_NA}`);
  
  try {
    // 1. 获取所有股票列表
    console.log('\n📊 获取股票列表...');
    const screenerData = await fetchWithRetry(
      'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000'
    );
    
    const allStocks = screenerData?.data?.table?.rows || [];
    console.log(`✅ 共找到 ${allStocks.length} 只股票`);
    
    if (allStocks.length === 0) {
      throw new Error('无法获取股票列表');
    }

    // 2. 加载之前的进度
    const processedSymbols = loadProgress();
    const dividendStocks = [];
    const errors = [];
    
    const remainingStocks = allStocks.filter(s => !processedSymbols.has(s.symbol));
    console.log(`📝 待处理: ${remainingStocks.length} 只（跳过已处理: ${processedSymbols.size} 只）`);
    
    // 3. 分批处理
    console.log('\n💰 开始获取股息数据...\n');
    
    for (let i = 0; i < remainingStocks.length; i += CONFIG.BATCH_SIZE) {
      const batch = remainingStocks.slice(i, i + CONFIG.BATCH_SIZE);
      
      const results = await Promise.all(
        batch.map(stock => fetchStockData(stock))
      );
      
      batch.forEach((stock, idx) => {
        processedSymbols.add(stock.symbol);
        if (results[idx]) {
          dividendStocks.push(results[idx]);
        }
      });
      
      // 显示进度
      const totalProcessed = processedSymbols.size;
      const percent = ((totalProcessed / allStocks.length) * 100).toFixed(1);
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      const speed = (totalProcessed / (Date.now() - startTime) * 1000).toFixed(1);
      const withGrowth = dividendStocks.filter(s => s.growthRate !== 'N/A').length;
      
      process.stdout.write(
        `\r📈 进度: ${totalProcessed}/${allStocks.length} (${percent}%) | ` +
        `股息股: ${dividendStocks.length} | ` +
        `有增长率: ${withGrowth} | ` +
        `速度: ${speed}/s | ` +
        `耗时: ${elapsed}分钟`
      );
      
      // 定期保存进度
      if (totalProcessed % CONFIG.SAVE_INTERVAL === 0) {
        saveProgress(dividendStocks, processedSymbols, errors);
      }
      
      await randomDelay();
    }

    console.log('\n');

    // 4. 按股息率排序
    dividendStocks.sort((a, b) => {
      const yA = parseFloat(a.dividendYield) || 0;
      const yB = parseFloat(b.dividendYield) || 0;
      return yB - yA;
    });

    // 5. 根据配置过滤
    const finalStocks = CONFIG.FILTER_NA 
      ? dividendStocks.filter(s => s.growthRate !== 'N/A')
      : dividendStocks;

    // 6. 统计信息
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
        errorCount: errors.length,
        durationMinutes: parseFloat(duration),
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

    // 7. 保存结果
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(outputData, null, 2));
    clearProgress();
    
    // 8. 输出统计
    console.log('✅ 数据获取完成！');
    console.log('═'.repeat(60));
    console.log(`📁 保存至: ${OUTPUT_FILE}`);
    console.log(`📊 扫描总数: ${allStocks.length}`);
    console.log(`💰 股息股票: ${dividendStocks.length}`);
    console.log(`📈 有增长率: ${growthStats.withGrowthData} (${growthStats.coveragePercent})`);
    console.log(`❓ 无增长率: ${growthStats.withoutGrowthData}`);
    console.log(`📦 最终输出: ${finalStocks.length} (过滤N/A: ${CONFIG.FILTER_NA})`);
    console.log(`⏱️ 总耗时: ${duration} 分钟`);
    console.log('═'.repeat(60));
    
    console.log('\n📊 增长率来源统计:');
    Object.entries(growthStats.bySource).forEach(([source, count]) => {
      console.log(`   ${source}: ${count}`);
    });
    
    console.log('\n🏆 Top 5 高股息:');
    outputData.statistics.top10ByYield.slice(0, 5).forEach((s, i) => {
      console.log(`   ${i + 1}. ${s.symbol} - ${s.yield} (增长: ${s.growthRate})`);
    });
    
    console.log('\n🚀 Top 5 高增长:');
    outputData.statistics.top10ByGrowth.slice(0, 5).forEach((s, i) => {
      console.log(`   ${i + 1}. ${s.symbol} - 增长 ${s.growthRate} (股息: ${s.yield})`);
    });

    // 保存错误日志
    if (errors.length > 0) {
      fs.writeFileSync(
        path.join(DATA_DIR, 'errors.json'),
        JSON.stringify({ date: new Date().toISOString(), errors: errors.slice(0, 100) }, null, 2)
      );
    }

    return outputData;

  } catch (error) {
    console.error('\n❌ 致命错误:', error);
    process.exit(1);
  }
}

// ============== 执行 ==============
fetchDividendStocks();