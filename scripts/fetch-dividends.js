const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// ============== 配置 ==============
const HEADERS = {
  'Accept': 'application/json',
  'Origin': 'https://www.nasdaq.com',
  'Referer': 'https://www.nasdaq.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

const BATCH_SIZE = 5;
const DELAY_MS = 150;
const STOCK_LIMIT = 10000;

// ============== 路径设置 ==============
const DATA_DIR = path.join(__dirname, '../data');
const OUTPUT_FILE = path.join(DATA_DIR, 'dividends.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ============== 工具函数 ==============

function parseRevenue(str) {
  if (!str) return null;
  const cleaned = str.replace(/[$,]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// 解析股息历史记录
function parseDividendHistory(dividends) {
  if (!dividends || !dividends.rows || !Array.isArray(dividends.rows)) {
    return [];
  }

  return dividends.rows.map(row => {
    return {
      exDate: row.exOrEffDate || '',           // 除息日
      type: row.type || '',                     // 类型 (Cash, Stock, etc.)
      amount: row.amount || '',                 // 股息金额
      declarationDate: row.declarationDate || '', // 宣布日
      recordDate: row.recordDate || '',         // 登记日
      paymentDate: row.paymentDate || '',       // 派息日
    };
  }).filter(item => item.exDate && item.amount); // 过滤无效记录
}

// 计算股息增长率
function calculateDividendGrowth(history) {
  if (!history || history.length < 2) {
    return { rate: 'N/A', years: 0 };
  }

  // 按年份分组，计算每年总股息
  const byYear = {};
  history.forEach(item => {
    if (!item.exDate) return;
    const year = item.exDate.split('/')[2] || item.exDate.split('-')[0];
    if (!year || year.length !== 4) return;
    
    const amount = parseFloat(item.amount.replace('$', '')) || 0;
    if (amount > 0) {
      byYear[year] = (byYear[year] || 0) + amount;
    }
  });

  const years = Object.keys(byYear).sort();
  if (years.length < 2) {
    return { rate: 'N/A', years: years.length };
  }

  // 计算年化增长率 (最早年 vs 最近年)
  const oldestYear = years[0];
  const latestYear = years[years.length - 1];
  const oldestAmount = byYear[oldestYear];
  const latestAmount = byYear[latestYear];
  const yearSpan = parseInt(latestYear) - parseInt(oldestYear);

  if (yearSpan > 0 && oldestAmount > 0) {
    const cagr = (Math.pow(latestAmount / oldestAmount, 1 / yearSpan) - 1) * 100;
    return {
      rate: `${cagr.toFixed(1)}%`,
      years: yearSpan,
      oldestYear,
      latestYear,
      oldestAmount: `$${oldestAmount.toFixed(2)}`,
      latestAmount: `$${latestAmount.toFixed(2)}`,
    };
  }

  return { rate: 'N/A', years: years.length };
}

// ============== 主函数 ==============

async function main() {
  const startTime = Date.now();

  try {
    console.log('Fetching all stocks...');
    
    const screenerRes = await fetch(
      `https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=${STOCK_LIMIT}`,
      { headers: HEADERS }
    );
    
    const screenerData = await screenerRes.json();
    const allStocks = screenerData?.data?.table?.rows || [];
    
    console.log(`Total stocks: ${allStocks.length}`);

    const dividendStocks = [];

    for (let i = 0; i < allStocks.length; i += BATCH_SIZE) {
      const batch = allStocks.slice(i, i + BATCH_SIZE);
      
      const results = await Promise.all(
        batch.map(async (stock) => {
          try {
            // 1. 获取股息信息
            const divRes = await fetch(
              `https://api.nasdaq.com/api/quote/${stock.symbol}/dividends?assetclass=stocks`,
              { headers: HEADERS }
            );
            
            if (!divRes.ok) return null;
            
            const divJson = await divRes.json();
            const divData = divJson?.data;
            
            const yieldStr = divData?.yield;
            const annualDiv = divData?.annualizedDividend;
            
            if (
              !yieldStr || !annualDiv ||
              yieldStr === 'N/A' || yieldStr === '--' ||
              annualDiv === 'N/A' || annualDiv === '0' ||
              parseFloat(yieldStr) <= 0
            ) {
              return null;
            }

            // ★ 获取历史股息记录
            const dividendHistory = parseDividendHistory(divData?.dividends);
            const dividendGrowth = calculateDividendGrowth(dividendHistory);

            // 2. 获取公司简介 + Sector/Industry
            let description = '';
            let sector = '';
            let industry = '';

            try {
              const profileRes = await fetch(
                `https://api.nasdaq.com/api/company/${stock.symbol}/company-profile`,
                { headers: HEADERS }
              );
              
              if (profileRes.ok) {
                const profileJson = await profileRes.json();
                const profileData = profileJson?.data;
                
                description = profileData?.CompanyDescription?.value || '';
                sector = profileData?.Sector?.value || '';
                industry = profileData?.Industry?.value || '';
              }
            } catch {}

            // 3. 如果 profile 没有 sector，从 summary 获取
            if (!sector) {
              try {
                const summaryRes = await fetch(
                  `https://api.nasdaq.com/api/quote/${stock.symbol}/summary?assetclass=stocks`,
                  { headers: HEADERS }
                );
                
                if (summaryRes.ok) {
                  const summaryJson = await summaryRes.json();
                  const summaryData = summaryJson?.data?.summaryData;
                  
                  sector = summaryData?.Sector?.value || '';
                  industry = summaryData?.Industry?.value || '';
                }
              } catch {}
            }

            // 4. 获取增长率
            let growthRate = '';
            let growthSource = '';

            try {
              const pegRes = await fetch(
                `https://api.nasdaq.com/api/analyst/${stock.symbol}/peg-ratio`,
                { headers: HEADERS }
              );
              
              if (pegRes.ok) {
                const pegJson = await pegRes.json();
                const growthData = pegJson?.data?.gr?.peGrowthChart?.find(
                  (item) => item.z === 'Growth'
                );
                if (growthData?.y && growthData.y !== 0) {
                  growthRate = `${growthData.y}%`;
                  growthSource = 'Analyst Forecast';
                }
              }
            } catch {}

            // 5. 如果没有增长率，计算历史收入增长
            if (!growthRate) {
              try {
                const finRes = await fetch(
                  `https://api.nasdaq.com/api/company/${stock.symbol}/financials?frequency=1`,
                  { headers: HEADERS }
                );
                
                if (finRes.ok) {
                  const finJson = await finRes.json();
                  const rows = finJson?.data?.incomeStatementTable?.rows || [];
                  
                  const revenueRow = rows.find((r) => 
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

            return {
              symbol: stock.symbol,
              name: stock.name,
              price: stock.lastsale,
              marketCap: stock.marketCap,
              sector: sector || 'N/A',
              industry: industry || 'N/A',
              dividendYield: yieldStr,
              annualDividend: `$${annualDiv}`,
              exDividendDate: divData.exDividendDate || '',
              paymentDate: divData.dividendPaymentDate || '',
              growthRate: growthRate || 'N/A',
              growthSource: growthSource || '',
              description: description || '',
              // ★ 新增：股息历史相关字段
              dividendHistory: dividendHistory,           // 所有历史股息记录
              dividendHistoryCount: dividendHistory.length, // 历史记录数量
              dividendGrowth: dividendGrowth,             // 股息增长率统计
            };
          } catch {
            return null;
          }
        })
      );

      results.forEach(r => { if (r) dividendStocks.push(r); });
      
      const progress = Math.min(i + BATCH_SIZE, allStocks.length);
      console.log(`Progress: ${progress}/${allStocks.length} | Found: ${dividendStocks.length}`);
      
      await new Promise(r => setTimeout(r, DELAY_MS));
    }

    // 排序
    dividendStocks.sort((a, b) => {
      const yA = parseFloat(a.dividendYield) || 0;
      const yB = parseFloat(b.dividendYield) || 0;
      return yB - yA;
    });

    // 统计所有行业
    const sectors = {};
    dividendStocks.forEach(s => {
      const sec = s.sector || 'N/A';
      sectors[sec] = (sectors[sec] || 0) + 1;
    });

    // 统计所有产业
    const industries = {};
    dividendStocks.forEach(s => {
      const ind = s.industry || 'N/A';
      industries[ind] = (industries[ind] || 0) + 1;
    });

    // 增长率统计
    const withGrowth = dividendStocks.filter(s => s.growthRate !== 'N/A').length;
    const withoutGrowth = dividendStocks.filter(s => s.growthRate === 'N/A').length;

    // ★ 股息历史统计
    const withDividendHistory = dividendStocks.filter(s => s.dividendHistoryCount > 0).length;
    const avgHistoryCount = dividendStocks.length > 0 
      ? (dividendStocks.reduce((sum, s) => sum + s.dividendHistoryCount, 0) / dividendStocks.length).toFixed(1)
      : 0;

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);

    // 构建输出数据
    const outputData = {
      success: true,
      lastUpdated: new Date().toISOString(),
      count: dividendStocks.length,
      totalScanned: allStocks.length,
      stats: {
        totalDividendStocks: dividendStocks.length,
        withGrowthData: withGrowth,
        withoutGrowthData: withoutGrowth,
        withDividendHistory: withDividendHistory,
        avgHistoryRecords: avgHistoryCount,
        durationMinutes: duration,
      },
      sectors: Object.entries(sectors)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count })),
      industries: Object.entries(industries)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count })),
      stocks: dividendStocks,
    };

    // 保存到文件
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(outputData, null, 2));

    // 输出统计
    console.log('\n✅ 完成！');
    console.log('═'.repeat(50));
    console.log(`📁 保存至: ${OUTPUT_FILE}`);
    console.log(`📊 总扫描: ${allStocks.length}`);
    console.log(`💰 股息股: ${dividendStocks.length}`);
    console.log(`📈 有增长率: ${withGrowth}`);
    console.log(`❓ 无增长率: ${withoutGrowth}`);
    console.log(`📜 有历史记录: ${withDividendHistory}`);
    console.log(`📊 平均历史记录数: ${avgHistoryCount}`);
    console.log(`⏱️ 耗时: ${duration} 分钟`);
    console.log('═'.repeat(50));
    
    // 显示示例
    if (dividendStocks.length > 0) {
      const sample = dividendStocks.find(s => s.dividendHistoryCount > 5) || dividendStocks[0];
      console.log('\n📋 示例数据 (' + sample.symbol + '):');
      console.log(`   股息率: ${sample.dividendYield}`);
      console.log(`   历史记录数: ${sample.dividendHistoryCount}`);
      console.log(`   股息增长率: ${sample.dividendGrowth.rate}`);
      if (sample.dividendHistory.length > 0) {
        console.log(`   最近派息: ${sample.dividendHistory[0].exDate} - ${sample.dividendHistory[0].amount}`);
      }
    }

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();