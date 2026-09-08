// ============================================================================
// 文件作用：zcode-watch 多 Key 月度用量悬浮窗（macOS 原生实现）
//
// 与 Windows 版(zcode-watch-widget.ps1)同数据同布局：每把 API Key 一张卡片，
// 显示档位、月度进度条(加权 = 非高峰×1 + 高峰×3)、高峰/非高峰用量与重置倒计时；
// 用满 100% 的 Key 红色横幅提醒删除。
//
// 设计原则（与 ZCodeUsageHUD 一致）：
//   - 纯壳：数据一律来自 node zcode-watch.mjs --json，本文件不含任何取数/换算逻辑，
//     与悬浮窗(Windows)/CLI/会话命令的口径永不打架
//   - Swift + AppKit 单文件，Command Line Tools 即可编译，零第三方依赖
//   - 全局快捷键走 Carbon RegisterEventHotKey，不需要「辅助功能」授权；
//     默认 Ctrl+Shift+G（Ctrl+G 留给 zcode-usage，两窗共存不冲突）
//   - node 多路径探测（nvm/homebrew/登录 shell 兜底）——应用可能被 Finder/launchd
//     拉起，PATH 是空的
//   - 失败要吵：找不到 node/脚本/配置时给出明确指引，不显示空白面板
//
// 支持范围：macOS 12+，Apple Silicon / Intel 均可
//
// 注意事项：
//   - 应用以 accessory 模式运行，不占 Dock，不抢焦点
//   - 配置文件 ~/.zcode/zcode-watch-hud/config.json 可改快捷键和刷新间隔
// ============================================================================

import AppKit
import Carbon.HIToolbox

// MARK: - 全局常量与路径

enum HUDPaths {
    static let home = NSHomeDirectory()
    static var baseDir: String { home + "/.zcode/zcode-watch-hud" }
    static var configPath: String { baseDir + "/config.json" }
    /// Key 配置文件（引擎读取的同一份），失败态引导用户去编辑它
    static var watchConfigPath: String { home + "/.zcode/zcode-watch.json" }
    /// 插件缓存根目录
    static var pluginCacheDir: String { home + "/.zcode/cli/plugins/cache" }
}

enum HUDMetrics {
    static let width: CGFloat = 372
    static let pad: CGFloat = 18
    static let corner: CGFloat = 16
}

// MARK: - 配置读写

/// 悬浮窗自身配置，保存在 config.json，允许用户手工编辑
struct HUDConfig {
    var hotkey: String = "ctrl+shift+g"
    var autoShowOnStart: Bool = true
    /// 默认 110 分钟，与引擎的「保底 2 小时拉取窗」配套：自动刷新也只拉增量 1 页
    var refreshIntervalMinutes: Double = 110
    var originX: Double? = nil
    var originY: Double? = nil
    var nodePath: String? = nil

    static func load() -> HUDConfig {
        var cfg = HUDConfig()
        guard let data = FileManager.default.contents(atPath: HUDPaths.configPath),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return cfg
        }
        if let v = obj["hotkey"] as? String, !v.isEmpty { cfg.hotkey = v }
        if let v = obj["autoShowOnStart"] as? Bool { cfg.autoShowOnStart = v }
        if let v = obj["refreshIntervalMinutes"] as? Double, v > 0 { cfg.refreshIntervalMinutes = v }
        if let v = obj["originX"] as? Double { cfg.originX = v }
        if let v = obj["originY"] as? Double { cfg.originY = v }
        if let v = obj["nodePath"] as? String, !v.isEmpty { cfg.nodePath = v }
        return cfg
    }

    func save() {
        var obj: [String: Any] = [
            "hotkey": hotkey,
            "autoShowOnStart": autoShowOnStart,
            "refreshIntervalMinutes": refreshIntervalMinutes,
        ]
        if let x = originX { obj["originX"] = x }
        if let y = originY { obj["originY"] = y }
        if let n = nodePath { obj["nodePath"] = n }
        try? FileManager.default.createDirectory(atPath: HUDPaths.baseDir,
                                                 withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: obj,
                                                  options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: HUDPaths.configPath))
        }
    }
}

// MARK: - 引擎 --json 的数据模型（契约见 PROJECT.md §7.1）

struct WatchKeyDTO: Codable {
    let id: String?
    let name: String?
    let provider: String?
    let keyTail: String?
    let level: String?
    let monthTokens: Double?
    let peakTokens: Double?
    let offPeakTokens: Double?
    let weightedTotal: Double?
    let monthlyQuota: Double?
    let percent: Double?
    let exhausted: Bool?
    let resetDate: String?
    let incomplete: Bool?
    let error: String?
}

struct WatchRootDTO: Codable {
    let month: String?
    let fetchedAt: Double?
    let empty: Bool?
    let error: String?
    let keys: [WatchKeyDTO]?
}

// MARK: - 展示用的格式化工具

enum Fmt {
    /// token 数量的中文缩写，1.25 亿 / 9.2 万（与引擎 fmtTokens 同口径）
    static func tokens(_ n: Double) -> String {
        if n >= 1e8 { return String(format: "%.2f 亿", n / 1e8) }
        if n >= 1e4 { return String(format: "%.1f 万", n / 1e4) }
        return String(format: "%.0f", n)
    }

    static func percent(_ p: Double) -> String {
        String(format: "已用 %.1f%%", p)
    }

    /// "2026-10-01" 距今天数（向上取整），解析失败返回 nil
    static func daysUntil(_ dateStr: String) -> Int? {
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = TimeZone(identifier: "Asia/Shanghai")
        guard let d = df.date(from: dateStr) else { return nil }
        let days = ceil(d.timeIntervalSinceNow / 86400)
        return days > 0 ? Int(days) : 0
    }

    /// 按已用比例给进度条配色：越接近用尽越警示（与 Windows 版阈值一致）
    static func tint(_ usedPercent: Double) -> NSColor {
        if usedPercent >= 85 { return .systemRed }
        if usedPercent >= 60 { return .systemOrange }
        return NSColor(calibratedRed: 0.20, green: 0.72, blue: 0.45, alpha: 1.0)
    }
}

// MARK: - 数据抓取：调用 zcode-watch.mjs --json

enum FetchResult {
    case success(WatchRootDTO)
    case failure(String)
}

final class WatchFetcher {

    private static var cachedNode: String?

    /// 定位 node 可执行文件。应用可能被 Finder/launchd 拉起，PATH 很干净，必须自己找。
    static func resolveNode(preferred: String?) -> String? {
        if let c = cachedNode, FileManager.default.isExecutableFile(atPath: c) { return c }
        let fm = FileManager.default
        var candidates: [String] = []
        if let env = ProcessInfo.processInfo.environment["ZW_HUD_NODE"] { candidates.append(env) }
        if let p = preferred { candidates.append(p) }
        let nvmDir = HUDPaths.home + "/.nvm/versions/node"
        if let vers = try? fm.contentsOfDirectory(atPath: nvmDir) {
            let sorted = vers.sorted { a, b in
                a.compare(b, options: .numeric) == .orderedDescending
            }
            candidates.append(contentsOf: sorted.map { nvmDir + "/" + $0 + "/bin/node" })
        }
        candidates.append(contentsOf: ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"])
        for c in candidates where fm.isExecutableFile(atPath: c) {
            cachedNode = c
            return c
        }
        // 兜底：走一次登录 shell 问 PATH
        if let out = runSync("/bin/zsh", ["-lc", "command -v node"], timeout: 8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !out.isEmpty, fm.isExecutableFile(atPath: out) {
            cachedNode = out
            return out
        }
        return nil
    }

    /// 定位引擎脚本：
    ///   1. 优先找应用包旁边自带的 scripts/zcode-watch.mjs（目录分享给别人也能用）
    ///   2. 回退到本机 ZCode 插件缓存，插件版本升级后自动选最新
    static func resolveScript() -> String? {
        let fm = FileManager.default
        let local = Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("scripts/zcode-watch.mjs").path
        if fm.fileExists(atPath: local) { return local }

        let root = HUDPaths.pluginCacheDir
        guard let markets = try? fm.contentsOfDirectory(atPath: root) else { return nil }
        var found: [(version: String, path: String)] = []
        for market in markets {
            let skillRoot = root + "/" + market + "/zcode-watch"
            guard let versions = try? fm.contentsOfDirectory(atPath: skillRoot) else { continue }
            for v in versions {
                let p = skillRoot + "/" + v + "/skills/zcode-watch/scripts/zcode-watch.mjs"
                if fm.fileExists(atPath: p) { found.append((v, p)) }
            }
        }
        return found.sorted { $0.version.compare($1.version, options: .numeric) == .orderedDescending }
            .first?.path
    }

    /// 同步执行外部命令，带超时保护
    @discardableResult
    private static func runSync(_ exe: String, _ args: [String], timeout: TimeInterval,
                                env: [String: String]? = nil) -> String? {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: exe)
        task.arguments = args
        if let env = env { task.environment = env }
        let outPipe = Pipe(), errPipe = Pipe()
        task.standardOutput = outPipe
        task.standardError = errPipe
        do { try task.run() } catch { return nil }

        let watchdog = DispatchWorkItem { if task.isRunning { task.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: watchdog)

        let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
        let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        watchdog.cancel()

        if task.terminationStatus != 0 {
            let err = String(data: errData, encoding: .utf8) ?? ""
            let out = String(data: outData, encoding: .utf8) ?? ""
            lastStderr = (err + "\n" + out).trimmingCharacters(in: .whitespacesAndNewlines)
            return nil
        }
        return String(data: outData, encoding: .utf8)
    }

    static var lastStderr: String = ""

    /// 后台线程抓取数据，完成后回主线程回调。Key 不经命令行参数（引擎自己读配置文件）。
    static func fetch(config: HUDConfig, completion: @escaping (FetchResult, String?) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            guard let script = resolveScript() else {
                DispatchQueue.main.async {
                    completion(.failure("找不到 zcode-watch.mjs，请确认 zcode-watch 插件已安装"), nil)
                }
                return
            }
            guard let node = resolveNode(preferred: config.nodePath) else {
                DispatchQueue.main.async {
                    completion(.failure("找不到 node，请安装 Node.js 18+（brew install node）"), nil)
                }
                return
            }
            lastStderr = ""
            // 引擎首刷会全量拉当月账单明细，给足超时
            guard let raw = runSync(node, [script, "--json"], timeout: 60) else {
                let detail = lastStderr.split(separator: "\n").first.map(String.init) ?? "脚本执行失败"
                DispatchQueue.main.async { completion(.failure(detail), node) }
                return
            }
            guard let start = raw.firstIndex(of: "{"),
                  let data = String(raw[start...]).data(using: .utf8),
                  let dto = try? JSONDecoder().decode(WatchRootDTO.self, from: data) else {
                DispatchQueue.main.async { completion(.failure("返回内容解析失败"), node) }
                return
            }
            DispatchQueue.main.async { completion(.success(dto), node) }
        }
    }
}

// MARK: - 进度条视图

final class BarView: NSView {
    var progress: CGFloat = 0 { didSet { needsDisplay = true } }
    var tint: NSColor = .systemGreen { didSet { needsDisplay = true } }

    override func draw(_ dirtyRect: NSRect) {
        let r = bounds
        guard r.height > 0 else { return }
        let radius = r.height / 2

        NSColor.labelColor.withAlphaComponent(0.14).setFill()
        NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius).fill()

        let ratio = max(0, min(1, progress))
        guard ratio > 0 else { return }
        let w = max(ratio * r.width, r.height)
        tint.setFill()
        NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: w, height: r.height),
                     xRadius: radius, yRadius: radius).fill()
    }
}

// MARK: - 单张 Key 卡片

/// 每把 Key 一张卡：卡头(名称+尾号+档位) / 满额或错误横幅 / 进度条 / 三行额度 / 重置行。
/// 纯展示，所有数字直接取自引擎 DTO。
final class KeyCardView: NSView {

    static func makeLabel(_ size: CGFloat,
                          _ weight: NSFont.Weight,
                          _ color: NSColor,
                          align: NSTextAlignment = .left) -> NSTextField {
        let l = NSTextField(labelWithString: "")
        l.font = .systemFont(ofSize: size, weight: weight)
        l.textColor = color
        l.alignment = align
        l.lineBreakMode = .byTruncatingTail
        l.isSelectable = false
        return l
    }

    let nameLabel = makeLabel(12.5, .semibold, .labelColor)
    let levelLabel = makeLabel(11, .bold, .secondaryLabelColor, align: .right)
    /// 满额横幅（常驻红）或错误信息，二选一展示
    let bannerLabel = makeLabel(10.5, .semibold, .systemRed)
    let usageTitleLabel = makeLabel(11.5, .medium, .tertiaryLabelColor)
    let percentLabel = makeLabel(12, .bold, .labelColor, align: .right)
    let bar = BarView()
    let totalLabel = makeLabel(10.5, .regular, .tertiaryLabelColor)
    let totalValue = makeLabel(10.5, .regular, .secondaryLabelColor, align: .right)
    let peakLabel = makeLabel(10.5, .regular, .tertiaryLabelColor)
    let peakValue = makeLabel(10.5, .regular, .secondaryLabelColor, align: .right)
    let offPeakLabel = makeLabel(10.5, .regular, .tertiaryLabelColor)
    let offPeakValue = makeLabel(10.5, .regular, .secondaryLabelColor, align: .right)
    let resetLabel = makeLabel(10, .regular, .quaternaryLabelColor)
    let noteLabel = makeLabel(10, .regular, .quaternaryLabelColor)

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        [nameLabel, levelLabel, bannerLabel, usageTitleLabel, percentLabel, bar,
         totalLabel, totalValue, peakLabel, peakValue, offPeakLabel, offPeakValue,
         resetLabel, noteLabel].forEach { addSubview($0) }
    }
    required init?(coder: NSCoder) { fatalError() }

    /// 卡片需要的实际高度（横幅按错误两行/满额一行,附注按需出现）
    private var bannerLines = 0
    private var noteVisible = false
    var preferredHeight: CGFloat {
        var h: CGFloat = 18 + 4
        if bannerLines > 0 { h += 14 * bannerLines + 2 }
        h += 4 + 16 + 4 + 6   // 月度用量行 + 进度条
        h += 3 * 15           // 三行额度
        h += 3 + 13           // 重置行
        if noteVisible { h += 3 + 13 }
        return h
    }

    override func layout() {
        super.layout()
        let w = bounds.width
        var y: CGFloat = 0
        nameLabel.frame = NSRect(x: 0, y: y, width: w - 90, height: 18)
        levelLabel.frame = NSRect(x: w - 90, y: y, width: 90, height: 18)
        y += 18 + 4
        if bannerLines > 0 {
            bannerLabel.frame = NSRect(x: 0, y: y, width: w, height: CGFloat(14 * bannerLines))
            y += 14 * bannerLines + 2
        }
        usageTitleLabel.frame = NSRect(x: 0, y: y, width: w - 110, height: 16)
        percentLabel.frame = NSRect(x: w - 110, y: y, width: 110, height: 16)
        y += 16 + 4
        bar.frame = NSRect(x: 0, y: y, width: w, height: 6)
        y += 6 + 4
        let line = { (l: NSTextField, v: NSTextField) in
            l.frame = NSRect(x: 0, y: y, width: w - 150, height: 15)
            v.frame = NSRect(x: w - 150, y: y, width: 150, height: 15)
            y += 15
        }
        line(totalLabel, totalValue)
        line(peakLabel, peakValue)
        line(offPeakLabel, offPeakValue)
        y += 3
        resetLabel.frame = NSRect(x: 0, y: y, width: w, height: 13)
        y += 13
        if noteVisible {
            y += 3
            noteLabel.frame = NSRect(x: 0, y: y, width: w, height: 13)
        }
    }

    func apply(_ k: WatchKeyDTO) {
        let name = k.name ?? k.id ?? "Key"
        let tail = k.keyTail ?? ""
        nameLabel.stringValue = "● \(name) \(tail)"
        levelLabel.stringValue = "[\(k.level ?? "?")]"

        let pct = k.percent ?? 0
        percentLabel.stringValue = Fmt.percent(pct)
        percentLabel.textColor = Fmt.tint(pct)
        bar.progress = CGFloat(max(0, min(1, pct / 100)))
        bar.tint = Fmt.tint(pct)

        totalLabel.stringValue = "总使用额度"
        totalValue.stringValue = "\(Fmt.tokens(k.weightedTotal ?? 0)) / \(Fmt.tokens(k.monthlyQuota ?? 0))"
        peakLabel.stringValue = "高峰期使用"
        peakValue.stringValue = "\(Fmt.tokens(k.peakTokens ?? 0))（×3 折算）"
        offPeakLabel.stringValue = "非高峰期使用"
        offPeakValue.stringValue = Fmt.tokens(k.offPeakTokens ?? 0)

        var reset = "↻ \(k.resetDate ?? "") 重置"
        if let d = k.resetDate, let days = Fmt.daysUntil(d), days > 0 {
            reset += " · 还剩 \(days) 天"
        }
        reset += " · 总额度 = 非高峰×1 + 高峰×3"
        resetLabel.stringValue = reset

        if let err = k.error, !err.isEmpty {
            let badKey = err.lowercased().contains("401") || err.contains("令牌") || err.contains("验证")
            bannerLabel.stringValue = "⚠ 查询失败：\(err)\n\(badKey ? "Key 无效，请检查 ~/.zcode/zcode-watch.json" : "稍后自动重试；持续失败请检查网络")"
            bannerLines = 2
            noteVisible = false
            noteLabel.stringValue = ""
        } else {
            bannerLabel.stringValue = "⚠ 本月已用满 100%，建议删除该 Key"
            bannerLines = (k.exhausted ?? false) ? 1 : 0
            noteVisible = k.incomplete ?? false
            noteLabel.stringValue = noteVisible ? "账单数据量过大，本轮未拉完，断点续拉中" : ""
        }
        bannerLabel.isHidden = bannerLines == 0
        noteLabel.isHidden = !noteVisible
        // 错误时数字行仍展示(引擎会带缓存值)或为 0,无需特殊处理
        needsLayout = true
    }
}

// MARK: - 提示卡片（空态 / 配置错误 / 全局失败）

final class MessageCardView: NSView {
    let titleLabel = KeyCardView.makeLabel(12.5, .semibold, .labelColor)
    let bodyLabel = KeyCardView.makeLabel(10.5, .regular, .tertiaryLabelColor)

    override var isFlipped: Bool { true }

    static let viewHeight: CGFloat = 84

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        bodyLabel.lineBreakMode = .byWordWrapping
        [titleLabel, bodyLabel].forEach { addSubview($0) }
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        titleLabel.frame = NSRect(x: 0, y: 0, width: bounds.width, height: 18)
        bodyLabel.frame = NSRect(x: 0, y: 22, width: bounds.width, height: 58)
    }

    func apply(title: String, body: String, color: NSColor) {
        titleLabel.stringValue = title
        titleLabel.textColor = color
        bodyLabel.stringValue = body
    }
}

// MARK: - 面板内容视图

final class HUDContentView: NSView {

    static func makeLabel(_ size: CGFloat,
                          _ weight: NSFont.Weight,
                          _ color: NSColor,
                          align: NSTextAlignment = .left) -> NSTextField {
        let l = NSTextField(labelWithString: "")
        l.font = .systemFont(ofSize: size, weight: weight)
        l.textColor = color
        l.alignment = align
        l.lineBreakMode = .byTruncatingTail
        l.isSelectable = false
        return l
    }

    let titleLabel = makeLabel(14, .bold, .labelColor)
    let metaLabel = makeLabel(10.5, .regular, .tertiaryLabelColor)
    let refreshButton = NSButton()
    let closeButton = NSButton()
    let hintLabel = makeLabel(10, .regular, .quaternaryLabelColor)
    let messageCard = MessageCardView()
    var cards: [KeyCardView] = []

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        titleLabel.stringValue = "⚡ zcode-watch"
        metaLabel.stringValue = "正在读取…"
        configureIconButton(refreshButton, title: "↻", tooltip: "立即刷新")
        configureIconButton(closeButton, title: "✕", tooltip: "收起面板")
        messageCard.isHidden = true
        [titleLabel, metaLabel, refreshButton, closeButton,
         messageCard, hintLabel].forEach { addSubview($0) }
    }
    required init?(coder: NSCoder) { fatalError() }

    private func configureIconButton(_ b: NSButton, title: String, tooltip: String) {
        b.title = title
        b.isBordered = false
        b.bezelStyle = .regularSquare
        b.font = .systemFont(ofSize: 13, weight: .medium)
        b.contentTintColor = .secondaryLabelColor
        b.toolTip = tooltip
        b.setButtonType(.momentaryChange)
    }

    /// 当前卡片数（含提示卡），供高度自适应
    private var visibleCardCount = 0

    override func layout() {
        super.layout()
        let pad = HUDMetrics.pad
        let w = bounds.width - pad * 2
        var y = pad - 2

        titleLabel.frame = NSRect(x: pad, y: y, width: w - 60, height: 20)
        closeButton.frame = NSRect(x: bounds.width - pad - 20, y: y, width: 20, height: 20)
        refreshButton.frame = NSRect(x: bounds.width - pad - 46, y: y, width: 20, height: 20)
        y += 21
        metaLabel.frame = NSRect(x: pad, y: y, width: w, height: 14)
        y += 14 + 12

        if !messageCard.isHidden {
            messageCard.frame = NSRect(x: pad, y: y, width: w, height: MessageCardView.viewHeight)
            y += MessageCardView.viewHeight
        }
        var first = true
        for card in cards where !card.isHidden {
            if !first { y += 10 }   // 卡片间距（对应 Windows 版分隔线留白）
            first = false
            card.frame = NSRect(x: pad, y: y, width: w, height: card.preferredHeight)
            card.needsLayout = true
            y += card.preferredHeight
        }
        hintLabel.frame = NSRect(x: pad, y: y + 6, width: w, height: 13)
    }

    var preferredHeight: CGFloat {
        var h = HUDMetrics.pad - 2 + 21 + 14 + 12
        if !messageCard.isHidden { h += MessageCardView.viewHeight }
        var first = true
        for card in cards where !card.isHidden {
            if !first { h += 10 }
            first = false
            h += card.preferredHeight
        }
        return h + 6 + 13 + HUDMetrics.pad
    }

    // MARK: 渲染

    func render(_ dto: WatchRootDTO, hotkeyText: String) {
        let keys = dto.keys ?? []
        messageCard.isHidden = true

        let df = DateFormatter()
        df.dateFormat = "HH:mm:ss"
        if let cfgErr = dto.error, !cfgErr.isEmpty {
            // 配置文件损坏等致命错误(引擎 --json 的 error 载荷,keys 为空)
            metaLabel.stringValue = "配置错误"
            showMessage(title: "⚠ 配置文件有误", color: .systemRed, body: cfgErr)
        } else if dto.empty == true || keys.isEmpty {
            metaLabel.stringValue = "zcode-watch"
            showMessage(title: "未配置 API Key", color: .systemOrange,
                        body: "编辑 \(HUDPaths.watchConfigPath)\n或在 ZCode 对话里说：「添加一个 zcode-watch key，名字 xx，Key 是 xxx」")
        } else {
            let okCount = keys.filter { ($0.error ?? "").isEmpty }.count
            metaLabel.stringValue = "\(dto.month ?? "") 月 · \(keys.count) 把 Key（\(okCount) 把正常）· 更新于 \(df.string(from: Date()))"
        }

        // 卡片按配置 Key 数量增减复用
        while cards.count < keys.count {
            let c = KeyCardView()
            cards.append(c)
            addSubview(c)
        }
        for (i, card) in cards.enumerated() {
            if i < keys.count {
                card.isHidden = false
                card.apply(keys[i])
            } else {
                card.isHidden = true
            }
        }
        hintLabel.stringValue = "\(hotkeyText) 唤出 / 收起 · 拖拽面板可移动位置"
        needsLayout = true
    }

    func renderError(_ message: String, hotkeyText: String) {
        messageCard.isHidden = true
        for card in cards { card.isHidden = true }
        metaLabel.stringValue = "读取失败"
        showMessage(title: "⚠ 读取失败", color: .systemRed,
                    body: "\(message)\n点 ↻ 重试；持续失败请检查 Node.js 与网络")
        hintLabel.stringValue = "\(hotkeyText) 唤出 / 收起 · 拖拽面板可移动位置"
        needsLayout = true
    }

    func renderLoading() {
        metaLabel.stringValue = "正在读取…（首刷会全量拉取当月账单，稍慢）"
    }

    private func showMessage(title: String, color: NSColor, body: String) {
        messageCard.apply(title: title, body: body, color: color)
        messageCard.isHidden = false
    }
}

// MARK: - 悬浮面板

final class HUDPanel: NSPanel {
    // 无边框窗口默认不能成为 key window，这里放开以便必要时响应键盘
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

// MARK: - 全局快捷键（Carbon，不需要辅助功能授权）

final class HotKeyCenter {
    static let shared = HotKeyCenter()
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    var onFire: (() -> Void)?

    static func parse(_ text: String) -> (keyCode: UInt32, modifiers: UInt32)? {
        let parts = text.lowercased()
            .split(whereSeparator: { $0 == "+" || $0 == "-" || $0 == " " })
            .map(String.init)
        guard let keyToken = parts.last else { return nil }
        var mods: UInt32 = 0
        for p in parts.dropLast() {
            switch p {
            case "ctrl", "control", "^": mods |= UInt32(controlKey)
            case "cmd", "command", "meta": mods |= UInt32(cmdKey)
            case "shift": mods |= UInt32(shiftKey)
            case "alt", "option", "opt": mods |= UInt32(optionKey)
            default: return nil
            }
        }
        guard let code = keyCodeMap[keyToken] else { return nil }
        return (code, mods)
    }

    static let keyCodeMap: [String: UInt32] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
        "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
        "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
        "space": 49, "escape": 53,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
        "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    ]

    static func display(_ text: String) -> String {
        var out = ""
        for p in text.lowercased().split(whereSeparator: { $0 == "+" || $0 == "-" || $0 == " " }) {
            switch p {
            case "ctrl", "control": out += "⌃"
            case "cmd", "command": out += "⌘"
            case "shift": out += "⇧"
            case "alt", "option", "opt": out += "⌥"
            default: out += p.uppercased()
            }
        }
        return out
    }

    @discardableResult
    func register(_ text: String) -> Bool {
        unregister()
        guard let (code, mods) = HotKeyCenter.parse(text) else { return false }

        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                 eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ -> OSStatus in
            DispatchQueue.main.async { HotKeyCenter.shared.onFire?() }
            return noErr
        }, 1, &spec, nil, &handlerRef)

        // signature 用四字符码 'ZCWH' 标识本应用的热键
        let hotKeyID = EventHotKeyID(signature: OSType(0x5A43_5748), id: 1)
        let status = RegisterEventHotKey(code, mods, hotKeyID,
                                         GetApplicationEventTarget(), 0, &hotKeyRef)
        return status == noErr
    }

    func unregister() {
        if let ref = hotKeyRef { UnregisterEventHotKey(ref); hotKeyRef = nil }
        if let h = handlerRef { RemoveEventHandler(h); handlerRef = nil }
    }
}

// MARK: - 应用主体

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {

    private var panel: HUDPanel!
    private var content: HUDContentView!
    private var statusItem: NSStatusItem!
    private var refreshTimer: Timer?
    private var config = HUDConfig.load()
    private var hotkeyOK = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        buildPanel()
        buildStatusItem()
        setupHotKey()

        if config.autoShowOnStart { showPanel() }
        refresh()
        startTimers()
    }

    /// 再次 open 本应用时（SessionStart 钩子每次会调一次），把面板重新弹出来
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showPanel()
        refresh()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        HotKeyCenter.shared.unregister()
    }

    // MARK: 界面搭建

    private func buildPanel() {
        let rect = NSRect(x: 0, y: 0, width: HUDMetrics.width, height: 240)
        panel = HUDPanel(contentRect: rect,
                         styleMask: [.borderless, .nonactivatingPanel],
                         backing: .buffered,
                         defer: false)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.delegate = self

        let effect = NSVisualEffectView(frame: rect)
        effect.material = .hudWindow
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.wantsLayer = true
        effect.layer?.cornerRadius = HUDMetrics.corner
        effect.layer?.masksToBounds = true
        effect.layer?.borderWidth = 1
        effect.layer?.borderColor = NSColor.white.withAlphaComponent(0.10).cgColor
        effect.autoresizingMask = [.width, .height]

        content = HUDContentView(frame: rect)
        content.autoresizingMask = [.width, .height]
        content.refreshButton.target = self
        content.refreshButton.action = #selector(refreshAction)
        content.closeButton.target = self
        content.closeButton.action = #selector(hidePanel)
        effect.addSubview(content)

        panel.contentView = effect
        restoreFrame()
    }

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "⚡"
        statusItem.button?.toolTip = "zcode-watch 多 Key 用量"

        let menu = NSMenu()
        let toggle = NSMenuItem(title: "显示 / 收起面板", action: #selector(togglePanel), keyEquivalent: "")
        toggle.target = self
        menu.addItem(toggle)
        let refreshItem = NSMenuItem(title: "立即刷新", action: #selector(refreshAction), keyEquivalent: "")
        refreshItem.target = self
        menu.addItem(refreshItem)
        let cfgItem = NSMenuItem(title: "打开 Key 配置文件所在文件夹", action: #selector(openConfigDir), keyEquivalent: "")
        cfgItem.target = self
        menu.addItem(cfgItem)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "退出", action: #selector(quitApp), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)
        statusItem.menu = menu
    }

    private func setupHotKey() {
        HotKeyCenter.shared.onFire = { [weak self] in self?.togglePanel() }
        hotkeyOK = HotKeyCenter.shared.register(config.hotkey)
        if !hotkeyOK {
            statusItem.button?.toolTip = "zcode-watch（快捷键 \(config.hotkey) 注册失败，可能被占用）"
        }
    }

    private func startTimers() {
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: config.refreshIntervalMinutes * 60,
                                            repeats: true) { [weak self] _ in
            guard let self = self, self.panel.isVisible else { return }
            self.refresh()
        }
    }

    private var hotkeyText: String {
        hotkeyOK ? HotKeyCenter.display(config.hotkey) : "菜单栏 ⚡"
    }

    // MARK: 窗口位置

    private func restoreFrame() {
        let size = NSSize(width: HUDMetrics.width, height: 240)
        var origin: NSPoint
        if let x = config.originX, let y = config.originY,
           isOnAnyScreen(NSRect(origin: NSPoint(x: x, y: y), size: size)) {
            origin = NSPoint(x: x, y: y)
        } else if let screen = NSScreen.main {
            let f = screen.visibleFrame
            origin = NSPoint(x: f.maxX - size.width - 24, y: f.maxY - size.height - 24)
        } else {
            origin = NSPoint(x: 100, y: 100)
        }
        panel.setFrame(NSRect(origin: origin, size: size), display: false)
    }

    private func isOnAnyScreen(_ rect: NSRect) -> Bool {
        NSScreen.screens.contains { $0.visibleFrame.intersects(rect) }
    }

    func windowDidMove(_ notification: Notification) {
        config.originX = Double(panel.frame.origin.x)
        config.originY = Double(panel.frame.origin.y)
        config.save()
    }

    // MARK: 行为

    @objc private func togglePanel() {
        if panel.isVisible { hidePanel() } else { showPanel(); refresh() }
    }

    @objc func showPanel() {
        if !isOnAnyScreen(panel.frame) { restoreFrame() }
        resizeToContent()
        panel.orderFrontRegardless()   // 不抢占前台应用焦点
    }

    @objc private func hidePanel() {
        panel.orderOut(nil)
    }

    @objc private func refreshAction() {
        refresh()
    }

    @objc private func openConfigDir() {
        NSWorkspace.shared.open(URL(fileURLWithPath: HUDPaths.home + "/.zcode"))
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }

    // MARK: 刷新

    private func resizeToContent() {
        let h = max(content.preferredHeight, 120)
        guard abs(h - panel.frame.height) > 0.5 else { return }
        // 保持左上角不动地改变高度，视觉上不跳
        var f = panel.frame
        f.origin.y += f.height - h
        f.size.height = h
        panel.setFrame(f, display: true)
    }

    private func refresh() {
        content.renderLoading()
        WatchFetcher.fetch(config: config) { [weak self] result, node in
            guard let self = self else { return }
            if let n = node, self.config.nodePath != n {
                self.config.nodePath = n
                self.config.save()
            }
            switch result {
            case .success(let dto):
                self.content.render(dto, hotkeyText: self.hotkeyText)
            case .failure(let msg):
                self.content.renderError(msg, hotkeyText: self.hotkeyText)
            }
            self.resizeToContent()
        }
    }
}

// MARK: - 入口

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
