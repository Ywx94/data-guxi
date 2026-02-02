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

// 解析股息历史 - 按年合并
function parseDividendHistory(dividends) {
  if (!dividends || !dividends.rows || !Array.isArray(dividends.rows)) {
    return [];
  }

  // 按年份分组累加
  const byYear = {};
  
  dividends.rows.forEach(row => {
    const exDate = row.exOrEffDate || '';
    const amountStr = row.amount || '';
    
    if (!exDate || !amountStr) return;
    
    // 提取年份 (支持 MM/DD/YYYY 或 YYYY-MM-DD 格式)
    let year = null;
    if (exDate.includes('/')) {
      const parts = exDate.split('/');
      year = parts[2]; // MM/DD/YYYY
    } else if (exDate.includes('-')) {
      year = exDate.split('-')[0]; // YYYY-MM-DD
    }
    
    if (!year || year.length !== 4) return;
    
    // 解析金额
    const amount = parseFloat(amountStr.replace('$', '')) || 0;
    if (amount <= 0) return;
    
    // 累加到对应年份
    byYear[year] = (byYear[year] || 0) + amount;
  });

  // 转换为数组，按年份升序排列（老的在前）
return Object.entries(byYear)
  .map(([year, amount]) => ({
    year: year,
    amount: `$${amount.toFixed(2)}`
  }))
  .sort((a, b) => parseInt(a.year) - parseInt(b.year));  // ← a 和 b 交换
}

// 计算股息增长率
function calculateDividendGrowth(history) {
  if (!history || history.length < 2) {
    return { rate: 'N/A', years: 0 };
  }

  // history 按年份升序排列，最老在前，最新在后
  const oldestYear = history[0].year;                        // 第一个是最老
  const latestYear = history[history.length - 1].year;       // 最后一个是最新
  const oldestAmount = parseFloat(history[0].amount.replace('$', ''));
  const latestAmount = parseFloat(history[history.length - 1].amount.replace('$', ''));
  const yearSpan = parseInt(latestYear) - parseInt(oldestYear);

  if (yearSpan > 0 && oldestAmount > 0 && latestAmount > 0) {
    const cagr = (Math.pow(latestAmount / oldestAmount, 1 / yearSpan) - 1) * 100;
    return {
      rate: `${cagr.toFixed(1)}%`,
      years: yearSpan,
    };
  }

  return { rate: 'N/A', years: 0 };
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

            // ★ 获取年度股息历史（已合并）
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
              // ★ 年度股息历史
              dividendHistory: dividendHistory,
              dividendYears: dividendHistory.length,
              dividendGrowth: dividendGrowth,
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

    // 统计
    const withGrowth = dividendStocks.filter(s => s.growthRate !== 'N/A').length;
    const withoutGrowth = dividendStocks.filter(s => s.growthRate === 'N/A').length;
    const withDividendHistory = dividendStocks.filter(s => s.dividendYears > 0).length;
    const avgYears = dividendStocks.length > 0 
      ? (dividendStocks.reduce((sum, s) => sum + s.dividendYears, 0) / dividendStocks.length).toFixed(1)
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
        avgDividendYears: avgYears,
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
    console.log(`📜 有历史记录: ${withDividendHistory}`);
    console.log(`📊 平均派息年数: ${avgYears} 年`);
    console.log(`⏱️ 耗时: ${duration} 分钟`);
    console.log('═'.repeat(50));
    
    // 显示示例
    if (dividendStocks.length > 0) {
      const sample = dividendStocks.find(s => s.dividendYears >= 5) || dividendStocks[0];
      console.log('\n📋 示例 (' + sample.symbol + '):');
      console.log(`   股息率: ${sample.dividendYield}`);
      console.log(`   派息年数: ${sample.dividendYears} 年`);
      console.log(`   股息增长率: ${sample.dividendGrowth.rate}`);
      console.log('   年度股息:');
      sample.dividendHistory.slice(0, 5).forEach(h => {
        console.log(`     ${h.year}: ${h.amount}`);
      });
    }

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();