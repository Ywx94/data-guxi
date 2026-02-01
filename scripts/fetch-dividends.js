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

const FILTER_NA = false; // 是否过滤没有增长率的股票

// ============== 路径设置 ==============
const DATA_DIR = path.join(__dirname, '../data');
const OUTPUT_FILE = path.join(DATA_DIR, 'dividends.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ============== 工具函数 ==============

// 解析收入字符串 "$416,161,000" -> 416161000
function parseRevenue(str) {
  if (!str) return null;
  const cleaned = str.replace(/[$,]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// ============== 主函数 ==============

async function main() {
  const startTime = Date.now();
  
  try {
    console.log('Fetching all stocks...');
    
    const screenerRes = await fetch(
      'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000',
      { headers: HEADERS }
    );
    
    const screenerData = await screenerRes.json();
    const allStocks = screenerData?.data?.table?.rows || [];
    
    console.log(`Total stocks: ${allStocks.length}`);

    const dividendStocks = [];
    const batchSize = 5;

    for (let i = 0; i < allStocks.length; i += batchSize) {
      const batch = allStocks.slice(i, i + batchSize);
      
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

            // 2. 获取公司简介
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

            // 3. 获取增长率（多个来源）
            let growthRate = '';
            let growthSource = '';

            // 来源1: PEG Ratio API（分析师预测）
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

            // 来源2: 如果没有，用财务数据计算历史增长率
            if (!growthRate) {
              try {
                const finRes = await fetch(
                  `https://api.nasdaq.com/api/company/${stock.symbol}/financials?frequency=1`,
                  { headers: HEADERS }
                );
                
                if (finRes.ok) {
                  const finJson = await finRes.json();
                  const rows = finJson?.data?.incomeStatementTable?.rows || [];
                  
                  // 找到 Total Revenue 行
                  const revenueRow = rows.find((r) => 
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

            return {
              symbol: stock.symbol,
              name: stock.name,
              price: stock.lastsale,
              marketCap: stock.marketCap,
              sector: sector || stock.sector || '',
              industry: industry || stock.industry || '',
              dividendYield: yieldStr,
              annualDividend: `$${annualDiv}`,
              exDividendDate: divData.exDividendDate || '',
              paymentDate: divData.dividendPaymentDate || '',
              growthRate: growthRate || 'N/A',
              growthSource: growthSource || '',
              description: description,
            };
          } catch {
            return null;
          }
        })
      );

      results.forEach(r => { if (r) dividendStocks.push(r); });
      
      const progress = Math.min(i + batchSize, allStocks.length);
      console.log(`Progress: ${progress}/${allStocks.length} | Found: ${dividendStocks.length}`);
      
      await new Promise(r => setTimeout(r, 150));
    }

    // 按股息率排序
    dividendStocks.sort((a, b) => {
      const yA = parseFloat(a.dividendYield) || 0;
      const yB = parseFloat(b.dividendYield) || 0;
      return yB - yA;
    });

    // 如果需要过滤 N/A
    const finalStocks = FILTER_NA 
      ? dividendStocks.filter(s => s.growthRate !== 'N/A')
      : dividendStocks;

    // 统计
    const withGrowth = dividendStocks.filter(s => s.growthRate !== 'N/A').length;
    const withoutGrowth = dividendStocks.filter(s => s.growthRate === 'N/A').length;

    // 构建输出数据
    const outputData = {
      success: true,
      lastUpdated: new Date().toISOString(),
      count: finalStocks.length,
      totalScanned: allStocks.length,
      stats: {
        totalDividendStocks: dividendStocks.length,
        withGrowthData: withGrowth,
        withoutGrowthData: withoutGrowth,
        durationMinutes: ((Date.now() - startTime) / 1000 / 60).toFixed(2),
      },
      stocks: finalStocks,
    };

    // 保存到文件
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(outputData, null, 2));

    console.log('\n✅ 完成！');
    console.log(`📁 保存至: ${OUTPUT_FILE}`);
    console.log(`📊 总扫描: ${allStocks.length}`);
    console.log(`💰 股息股: ${dividendStocks.length}`);
    console.log(`📈 有增长率: ${withGrowth}`);
    console.log(`❓ 无增长率: ${withoutGrowth}`);
    console.log(`⏱️ 耗时: ${outputData.stats.durationMinutes} 分钟`);

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// 执行
main();