// main.ts

function checkPrice() {
  const now = new Date()

  Logger.log('Script run timestamp: %s', now)

  const priceDataset = fetchPriceDataset(now)
  const priceReportSet = priceDataset.buildReportSet()

  const emails = settings.loadUsers(now)

  for (const email of emails) {
    email.addReports(priceReportSet)

    email.trySend()
  }
}

function testScript() {
  const now = new Date()

  Logger.log('Script run timestamp: %s', now)

  const priceDataset = fetchPriceDataset(now)
  const priceReportSet = priceDataset.buildReportSet()

  const email = new ReportEmail('timnew@hey.com', now, ['U98', 'U95'], 'VIC', true)

  email.addReports(priceReportSet)

  email.trySend()
}

// common_types.ts
type StateName = 'VIC' | 'NSW' | 'QLD' | 'WA'
type RegionName = 'All' | StateName
const ALL_REGIONS: RegionName[] = ['All', 'VIC', 'NSW', 'QLD', 'WA']

type FuelType = 'E10' | 'U91' | 'U95' | 'U98' | 'Diesel' | 'LPG'
const ALL_FUEL_TYPES: FuelType[] = ['E10', 'U91', 'U95', 'U98', 'Diesel', 'LPG']

interface PriceInfo {
  readonly timestamp: number
  readonly state: StateName
  readonly suburb: string
  readonly price: number
}

// api_types.ts

interface ApiResponse {
  readonly updated: Number
  readonly regions: RegionData[]
}

interface RegionData {
  readonly region: string
  readonly prices: PriceData[]
}

interface PriceData {
  readonly type: FuelType
  readonly price: number
  readonly name: string
  readonly state: StateName
  readonly postcode: string
  readonly suburb: string
  readonly lat: number
  readonly lng: number
}

// api_repository.ts

function fetchPriceDataset(now: Date): PriceInfoSet {
  const timestamp = Math.round(now.getTime() / 1000)
  const url = `https://projectzerothree.info/api.php?format=json&t=${timestamp}`

  Logger.log('Load JSON from %s', url)
  const response = UrlFetchApp.fetch(url)
  Logger.log('Response code: %s', response.getResponseCode())

  const body = response.getContentText()
  const data = JSON.parse(body) as ApiResponse

  Logger.log('Data downloaded, parsing...')

  const result = transformData(data, now.getTime())

  Logger.log('Found %s price data points', result.length)

  return new PriceInfoSet(result)
}

function transformData(data: ApiResponse, timestamp: number): PriceInfoWithMeta[] {
  return data.regions.flatMap((regionData) => {
    const [region, index] = parseRegionName(regionData.region)

    return regionData.prices.flatMap((priceData) => ({
      type: priceData.type,
      region: region,
      index: index,
      priceInfo: {
        state: priceData.state,
        suburb: priceData.suburb,
        price: priceData.price,
        timestamp: timestamp,
      },
    }))
  })
}

function parseRegionName(rawName: string): [RegionName, number] {
  const parts = rawName.split('-')

  const region = parts[0] as RegionName
  const index = parts.length == 1 ? 1 : parseInt(parts[1])

  return [region, index]
}

// models.ts

interface PriceInfoWithMeta {
  readonly region: RegionName
  readonly type: FuelType
  readonly index: number
  readonly priceInfo: PriceInfo
}

enum PriceTrend {
  FastDrop = -2,
  Dropped = -1,
  NoChange = 0,
  Raised = 1,
  FastRaise = 2,
}

type PriceReportSet = {
  [key in FuelType]: {
    [key in RegionName]: PriceReport
  }
}

class PriceReport {
  constructor(
    readonly type: FuelType,
    readonly region: RegionName,
    readonly latestPrices: PriceInfo[],
    readonly historyPrices: PriceInfo[],
    readonly priceDelta: number,
    readonly trend: PriceTrend
  ) {}

  get bestPrice(): number {
    return this.latestPrices[0].price
  }

  get priceChanged(): boolean {
    return this.trend != PriceTrend.NoChange
  }
}

class PriceInfoSet {
  constructor(readonly dataset: PriceInfoWithMeta[]) {}

  buildReportSet(): PriceReportSet {
    const result: PriceReportSet = {} as PriceReportSet

    for (const fuelType of ALL_FUEL_TYPES) {
      const typeReport = {} as { [key in RegionName]: PriceReport }
      result[fuelType] = typeReport

      for (const region of ALL_REGIONS) {
        Logger.log('Check %s@%s', fuelType, region)

        const report = this.buildReport(fuelType, region)

        typeReport[region] = report
      }
    }

    return result
  }

  private buildReport(fuelType: FuelType, region: RegionName): PriceReport {
    Logger.log('Build report for %s@%s', fuelType, region)

    const latestPrices = this.findLatestPrices(fuelType, region)
    Logger.log('Latest %s prices found', latestPrices.length)

    let bestPrice: PriceInfo | null

    if (latestPrices.length > 0) {
      bestPrice = latestPrices[0]
      Logger.log('Best price is %s', bestPrice)
    } else {
      bestPrice = null
      Logger.log('No latest prices found')
    }

    const [historyPrices, changed] = this.buildHistoryPrices(fuelType, region, bestPrice)

    let priceDelta: number = 0
    let priceTrend: PriceTrend = PriceTrend.NoChange

    if (changed && historyPrices.length >= 2) {
      const [previous, latest] = historyPrices.slice(historyPrices.length - 2)

      priceDelta = latest.price - previous.price
      priceTrend = this.findPriceTrend(priceDelta)
      Logger.log('Price trend: %s -> %s', formatPrice(priceDelta), priceTrend)
    } else if (changed && historyPrices.length == 1) {
      Logger.log('New data point available')
      priceDelta = historyPrices[0].price
      priceTrend = this.findPriceTrend(priceDelta)
    } else {
      Logger.log('Price not changed')
      priceDelta = 0
      priceTrend = PriceTrend.NoChange
    }

    Logger.log('Build report for %s@%s', fuelType, region)
    return new PriceReport(fuelType, region, latestPrices, historyPrices, priceDelta, priceTrend)
  }

  private findLatestPrices(fuelType: FuelType, region: RegionName): PriceInfo[] {
    const latestPrices = this.dataset.filter((d) => d.type === fuelType && d.region === region)
    latestPrices.sort((a, b) => a.index - b.index)

    return latestPrices.map((d) => d.priceInfo)
  }

  private buildHistoryPrices(
    fuelType: FuelType,
    region: RegionName,
    newPrice: PriceInfo | null
  ): [PriceInfo[], boolean] {
    const key = `${fuelType}-${region}`

    const history = fetchListToScriptProperties<PriceInfo>(key)

    if (newPrice == null) {
      return [history, false]
    }

    const [updatedHistory, changed] = this.updateHistoryPrice(history, newPrice)

    if (changed) {
      Logger.log('Save updated history')

      storeListToScriptProperties<PriceInfo>(key, updatedHistory)
    }

    return [updatedHistory, changed]
  }

  private updateHistoryPrice(history: PriceInfo[], newPrice: PriceInfo): [PriceInfo[], boolean] {
    if (history.length == 0) {
      Logger.log('No history, build new one')
      return [[newPrice], true]
    }

    const lastPrice = history[history.length - 1]
    if (lastPrice.price === newPrice.price) {
      Logger.log('Price not changed, return the loaded history')
      return [history, false]
    }

    Logger.log('Price changed, update history')
    const historyToDrop = history.length < settings.historyLimit ? 0 : 1
    Logger.log('History to drop: %s', historyToDrop)
    const updatedHistory = [...history.slice(historyToDrop), newPrice]
    Logger.log('Updated history length: %s', updatedHistory.length)

    return [updatedHistory, true]
  }

  private findPriceTrend(priceDelta: number): PriceTrend {
    const absDelta = Math.abs(priceDelta)

    if (absDelta < 0.01) {
      return PriceTrend.NoChange
    } else if (priceDelta > 0) {
      return absDelta > settings.alertThreshold ? PriceTrend.FastRaise : PriceTrend.Raised
    } else {
      // if (priceDelta < 0)
      return absDelta > settings.alertThreshold ? PriceTrend.FastDrop : PriceTrend.Dropped
    }
  }
}

// email.ts

class ReportEmail {
  reports: PriceReport[] = []
  changed: boolean = false

  constructor(
    readonly recipient: string,
    readonly now: Date,
    readonly fuelTypes: FuelType[],
    readonly homeState: StateName | null,
    readonly forceSend: boolean = false
  ) {}

  addReports(reportSet: PriceReportSet) {
    Logger.log('Build email for %s', this.recipient)

    for (const fuelType of this.fuelTypes) {
      const typeReports = reportSet[fuelType]

      for (const region of ['All', this.homeState] as RegionName[]) {
        if (region == null) {
          Logger.log('region is null, skip')
          continue
        }

        Logger.log('Add report %s@%s', fuelType, region)

        const report = typeReports[region]
        this.addReport(report)
      }
    }

    Logger.log('Reports added, data changed: %s', this.changed)
  }

  private addReport(report: PriceReport | null) {
    if (report != null) {
      Logger.log('Adding report: %s@%s', report.type, report.region)
      this.reports.push(report)
      this.changed ||= report.priceChanged
    } else {
      Logger.log('no report found')
    }
  }

  private buildSubject(): string {
    return `🔔711: ${this.subjectFuelType()}@${this.subjectRegion()} has ${this.subjectTrendDirection()} ${this.subjectTrendSpeed()}`
  }

  private uniqueValueOrCount<T>(values: Array<T>): [number, T | null] {
    const set = new Set<T>(values)
    Logger.log('Values: %s', values)
    Logger.log('Unique count: %s', set.size)
    if (set.size === 1) {
      return [1, values[0]]
    } else {
      return [set.size, null]
    }
  }

  private subjectFuelType(): string {
    const [count, uniqueFuelType] = this.uniqueValueOrCount(this.reports.map((report) => report.type))

    if (count == 1) {
      return uniqueFuelType as string
    } else {
      return `${count} fuel types`
    }
  }

  private subjectRegion(): string {
    const [count, uniqueRegion] = this.uniqueValueOrCount(this.reports.map((report) => report.region))

    if (count == 1) {
      return uniqueRegion as string
    } else {
      return `${count} regions`
    }
  }

  private subjectTrendDirection(): string {
    const [_, direction] = this.uniqueValueOrCount(this.reports.map((report) => report.trend.valueOf() > 0))

    switch (direction) {
      case true:
        return 'increased'
      case false:
        return 'dropped'
      default:
        return 'changed'
    }
  }

  private subjectTrendSpeed(): string {
    const [_, speed] = this.uniqueValueOrCount(this.reports.map((report) => Math.abs(report.trend.valueOf()) > 1))

    switch (speed) {
      case true:
        return 'significantly'
      case false:
        return 'gradually'
      default:
        return 'with variant speed'
    }
  }

  private bodySummaryBlock(): String {
    return this.reports
      .map(
        (report) =>
          `${report.type}@${report.region} has ${priceTrendToText(report.trend)} by ${formatPrice(
            report.priceDelta
          )} at ${formatPrice(report.bestPrice)}`
      )
      .join('<br>')
  }

  private bodyReportsBlock(): String {
    return this.reports
      .map((report) => {
        return `
          <h3>${report.type}@${report.region}</h3>
          ${this.buildHistoryPrices(report)}
          ${this.buildLatestPrices(report)}
        `
      })
      .join('<br>')
  }

  private buildHistoryPrices(report: PriceReport): string {
    const rowsHtml = report.historyPrices
      .map(
        (priceInfo) =>
          `<tr><td>${timeSince(this.now, priceInfo.timestamp)}</td><td>${formatPrice(priceInfo.price)}</td></tr>`
      )
      .join('')

    return `
    <h3>Change History</h3>
    <table>
      <tr>
        <th>Time</th>
        <th>Price</th>
      </tr>
      ${rowsHtml}
    </table>
    `
  }

  private buildLatestPrices(report: PriceReport): string {
    const rowsHtml = report.latestPrices
      .map((priceInfo) => `<tr><td>${priceInfo.suburb} ${priceInfo.state}</td><td>${priceInfo.price}</td></tr>`)
      .join('')

    return `
    <h3>Latest Best Price</h3>
    <table>
      <tr>
        <th>Suburb</th>
        <th>Price</th>
      </tr>
      ${rowsHtml}
    </table>
    `
  }

  private buildBody(): String {
    return `
    <h2>Summary</h2>
    ${this.bodySummaryBlock()}
    <br>
    ${this.bodyReportsBlock()}
   `
  }

  trySend() {
    if (this.changed) {
      Logger.log('Data changed, sending email')
      this.send()
    } else if (this.forceSend) {
      Logger.log('Data not changed, but force send requested, sending email')
      this.send()
    } else {
      Logger.log('Data not changed, skip sending')
    }
  }

  send() {
    Logger.log('Recipient: %s', this.recipient)

    const subject = this.buildSubject()
    Logger.log('Subject: %s', subject)

    const htmlBody = this.buildBody()
    Logger.log('Body: %s', htmlBody)

    MailApp.sendEmail({
      to: this.recipient,
      subject,
      htmlBody,
    } as GoogleAppsScript.Mail.MailAdvancedParameters)
  }
}

function priceTrendToText(alert: PriceTrend): string {
  switch (alert) {
    case PriceTrend.NoChange:
      return '➡️'
    case PriceTrend.Raised:
      return '↗️'
    case PriceTrend.Dropped:
      return '↘️'
    case PriceTrend.FastRaise:
      return '⬆️'
    case PriceTrend.FastDrop:
      return '⬇️'
  }
}

function timeSince(now: Date, date: number): String {
  var seconds = Math.floor((now.getTime() - date) / 1000)

  var interval = Math.floor(seconds / 31536000)
  if (interval > 1) {
    return interval + ' years ago'
  }
  interval = Math.floor(seconds / 2592000)
  if (interval > 1) {
    return interval + ' months ago'
  }
  interval = Math.floor(seconds / 86400)
  if (interval > 1) {
    return interval + ' days ago'
  }
  interval = Math.floor(seconds / 3600)
  if (interval > 1) {
    return interval + ' hours ago'
  }
  interval = Math.floor(seconds / 60)
  if (interval > 1) {
    return interval + ' minutes ago'
  }
  return Math.floor(seconds) + ' seconds ago'
}

function formatPrice(price: Number): String {
  return `$${price.toFixed(2)}`
}

// script_properties.ts
const scriptProperties = PropertiesService.getScriptProperties()

function fetchListToScriptProperties<T>(key: string): T[] {
  Logger.log('Load list from ScriptProperties from key %s', key)

  const json = scriptProperties.getProperty(key) ?? '[]'

  const result = JSON.parse(json) as T[]

  Logger.log('%s records loaded', result.length)

  return result
}
function storeListToScriptProperties<T>(key: string, data: T[]) {
  Logger.log('Store list to ScriptProperties for key %s', key)

  scriptProperties.setProperty(key, JSON.stringify(data))

  Logger.log('%s records stored', data.length)
}

// dynamic settings.ts
class DynamicSettings {
  constructor(private properties: GoogleAppsScript.Properties.Properties = PropertiesService.getScriptProperties()) {}

  get alertThreshold(): number {
    return parseFloat(this.properties.getProperty('alertThreshold') ?? '3.0')
  }

  get historyLimit(): number {
    return parseFloat(this.properties.getProperty('historyLimit') ?? '5')
  }

  loadUsers(now: Date): ReportEmail[] {
    return this.properties
      .getKeys()
      .filter((key) => key.includes('@'))
      .map((email) => {
        Logger.log('Load user settings for %s', email)

        const settingJson = this.properties.getProperty(email)!
        Logger.log('Settings loaded: %s', settingJson)

        const [fuelTypes, state] = JSON.parse(settingJson) as [FuelType[], StateName]

        const reportEmail = new ReportEmail(email, now, fuelTypes, state)

        Logger.log('User report email created')

        return reportEmail
      })
  }
}

class UserSettings {
  constructor(public recipient: string) {}
}

const settings = new DynamicSettings()
