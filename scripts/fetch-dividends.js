const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const HEADERS = {
  'Accept': 'application/json',
  'Origin': 'https://www.nasdaq.com',
  'Referer': 'https://www.nasdaq.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

const DATA_DIR = path.join(__dirname, '../data');
const OUTPUT_FILE = path.join(DATA_DIR, 'dividends.json');

// 确保 data 目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 延迟函数
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 安全获取 JSON
async function safeFetch(url) {
  try {
    const res = await fetch(url, { 
      headers: HEADERS,
      timeout: 10000 
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (error) {
    return null;
  }
}

// 主函数
async function fetchDividendStocks() {
  console.log('🚀 开始获取股票数据...');
  console.log(`⏰ 时间: ${new Date().toISOString()}`);
  
  try {
    // 1. 获取所有股票列表
    console.log('\n📊 获取股票列表...');
    const screenerData = await safeFetch(
      'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000'
    );
    
    const allStocks = screenerData?.data?.table?.rows || [];
    console.log(`✅ 共找到 ${allStocks.length} 只股票`);
    
    if (allStocks.length === 0) {
      throw new Error('无法获取股票列表');
    }

    const dividendStocks = [];
    const batchSize = 5;
    const errors = [];
    
    // 2. 遍历获取股息信息
    console.log('\n💰 开始获取股息数据...\n');
    
    for (let i = 0; i < allStocks.length; i += batchSize) {
      const batch = allStocks.slice(i, i + batchSize);
      
      const results = await Promise.all(
        batch.map(async (stock) => {
          try {
            // 获取股息信息
            const divJson = await safeFetch(
              `https://api.nasdaq.com/api/quote/${stock.symbol}/dividends?assetclass=stocks`
            );
            
            const divData = divJson?.data;
            if (!divData) return null;
            
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

            // 获取公司简介
            let description = '';
            let sector = stock.sector || '';
            let industry = stock.industry || '';

            const profileJson = await safeFetch(
              `https://api.nasdaq.com/api/company/${stock.symbol}/company-profile`
            );
            
            if (profileJson?.data) {
              description = profileJson.data.CompanyDescription?.value || '';
              sector = profileJson.data.Sector?.value || sector;
              industry = profileJson.data.Industry?.value || industry;
            }

            // 获取增长率和 PEG
            let growthRate = 'N/A';
            let pegRatio = 'N/A';

            const pegJson = await safeFetch(
              `https://api.nasdaq.com/api/analyst/${stock.symbol}/peg-ratio`
            );
            
            if (pegJson?.data) {
              pegRatio = pegJson.data.pegr?.pegValue?.toString() || 'N/A';
              
              const growthData = pegJson.data.gr?.peGrowthChart?.find(
                (item) => item.z === 'Growth'
              );
              if (growthData?.y) {
                growthRate = `${growthData.y}%`;
              }
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
              growthRate,
              pegRatio,
              description,
            };
          } catch (error) {
            errors.push({ symbol: stock.symbol, error: error.message });
            return null;
          }
        })
      );

      // 收集有效结果
      results.forEach(r => { if (r) dividendStocks.push(r); });
      
      // 显示进度
      const progress = Math.min(i + batchSize, allStocks.length);
      const percent = ((progress / allStocks.length) * 100).toFixed(1);
      process.stdout.write(
        `\r📈 进度: ${progress}/${allStocks.length} (${percent}%) | 找到股息股: ${dividendStocks.length}`
      );
      
      // 延迟避免请求过快
      await delay(200);
    }

    console.log('\n');

    // 3. 按股息率排序
    dividendStocks.sort((a, b) => {
      const yA = parseFloat(a.dividendYield) || 0;
      const yB = parseFloat(b.dividendYield) || 0;
      return yB - yA;
    });

    // 4. 构建输出数据
    const outputData = {
      lastUpdated: new Date().toISOString(),
      metadata: {
        totalScanned: allStocks.length,
        dividendStocksCount: dividendStocks.length,
        errorCount: errors.length,
        generatedBy: 'GitHub Actions',
      },
      // 统计信息
      statistics: {
        bySector: getSectorStats(dividendStocks),
        yieldRanges: getYieldRanges(dividendStocks),
        top10ByYield: dividendStocks.slice(0, 10).map(s => ({
          symbol: s.symbol,
          name: s.name,
          yield: s.dividendYield
        })),
      },
      // 完整数据
      stocks: dividendStocks,
    };

    // 5. 保存到文件
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(outputData, null, 2));
    
    console.log('✅ 数据获取完成！');
    console.log(`📁 保存至: ${OUTPUT_FILE}`);
    console.log(`📊 股息股票数量: ${dividendStocks.length}`);
    console.log(`❌ 错误数量: ${errors.length}`);

    // 保存错误日志
    if (errors.length > 0) {
      const errorFile = path.join(DATA_DIR, 'errors.json');
      fs.writeFileSync(errorFile, JSON.stringify({
        date: new Date().toISOString(),
        errors: errors.slice(0, 100)
      }, null, 2));
    }

    return outputData;

  } catch (error) {
    console.error('❌ 致命错误:', error);
    process.exit(1);
  }
}

// 按行业统计
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

// 股息率分布
function getYieldRanges(stocks) {
  const ranges = {
    '0-2%': 0,
    '2-4%': 0,
    '4-6%': 0,
    '6-8%': 0,
    '8-10%': 0,
    '10%+': 0,
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

// 执行
fetchDividendStocks();