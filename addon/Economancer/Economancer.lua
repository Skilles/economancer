-- Economancer companion addon.
-- Records gold, bags, bank, professions, known recipes and auction-house mail invoices,
-- then shows an export string (/econ) to paste into the Economancer website.
-- Written defensively: WoW: Forever's client mixes classic and modern APIs, so every
-- scan tries the modern API first and falls back to the classic one.

local ADDON = "Economancer"
local VERSION = "0.1.0"
local LEDGER_KEEP_DAYS = 45
local EXPORT_LEDGER_DAYS = 30

EconomancerDB = EconomancerDB or {}

local f = CreateFrame("Frame")
local charKey
local bankOpen = false

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------

local function itemIdFromLink(link)
  if not link then
    return nil
  end
  local id = link:match("item:(%d+)")
  if id then
    return tonumber(id)
  end
  return nil
end

local function spellIdFromLink(link)
  if not link then
    return nil
  end
  local id = link:match("enchant:(%d+)") or link:match("spell:(%d+)")
  if id then
    return tonumber(id)
  end
  return nil
end

local function safe(fn, ...)
  local ok, a, b, c, d, e, g, h, i, j, k = pcall(fn, ...)
  if ok then
    return a, b, c, d, e, g, h, i, j, k
  end
  return nil
end

local function charData()
  EconomancerDB.chars = EconomancerDB.chars or {}
  local c = EconomancerDB.chars[charKey]
  if not c then
    c = { bags = {}, bank = {}, profs = {}, known = {} }
    EconomancerDB.chars[charKey] = c
  end
  return c
end

-- ---------------------------------------------------------------------------
-- containers
-- ---------------------------------------------------------------------------

local function containerSlots(bag)
  if C_Container and C_Container.GetContainerNumSlots then
    return C_Container.GetContainerNumSlots(bag) or 0
  end
  if GetContainerNumSlots then
    return GetContainerNumSlots(bag) or 0
  end
  return 0
end

local function containerItem(bag, slot)
  if C_Container and C_Container.GetContainerItemInfo then
    local info = C_Container.GetContainerItemInfo(bag, slot)
    if info and info.itemID then
      return info.itemID, info.stackCount or 1
    end
    return nil
  end
  if GetContainerItemLink then
    local link = GetContainerItemLink(bag, slot)
    local id = itemIdFromLink(link)
    if id then
      local _, count = GetContainerItemInfo(bag, slot)
      return id, count or 1
    end
  end
  return nil
end

local function scanContainers(bags)
  local items = {}
  for _, bag in ipairs(bags) do
    local n = safe(containerSlots, bag) or 0
    for slot = 1, n do
      local id, count = safe(containerItem, bag, slot)
      if id then
        items[id] = (items[id] or 0) + (count or 1)
      end
    end
  end
  return items
end

local function scanBags()
  local numBags = NUM_BAG_SLOTS or 4
  local bags = {}
  for b = 0, numBags do
    table.insert(bags, b)
  end
  if NUM_REAGENTBAG_SLOTS and NUM_REAGENTBAG_SLOTS > 0 then
    table.insert(bags, numBags + 1)
  end
  local c = charData()
  c.bags = scanContainers(bags)
  c.gold = GetMoney()
  c.scanned = time()
end

local function scanBank()
  local numBags = NUM_BAG_SLOTS or 4
  local first = numBags + 1
  if NUM_REAGENTBAG_SLOTS and NUM_REAGENTBAG_SLOTS > 0 then
    first = first + NUM_REAGENTBAG_SLOTS
  end
  local bags = { BANK_CONTAINER or -1 }
  for b = first, first + (NUM_BANKBAGSLOTS or 6) - 1 do
    table.insert(bags, b)
  end
  if REAGENTBANK_CONTAINER then
    table.insert(bags, REAGENTBANK_CONTAINER)
  end
  local c = charData()
  c.bank = scanContainers(bags)
  c.bankScanned = time()
end

-- ---------------------------------------------------------------------------
-- professions
-- ---------------------------------------------------------------------------

local PROFESSIONS = {
  Alchemy = true, Blacksmithing = true, Enchanting = true, Engineering = true, Herbalism = true,
  Leatherworking = true, Mining = true, Skinning = true, Tailoring = true, Jewelcrafting = true,
  Inscription = true, Cooking = true, ["First Aid"] = true, Fishing = true, Survival = true,
}

local function scanProfessions()
  local profs = {}
  if GetProfessions and GetProfessionInfo then
    local list = { GetProfessions() }
    for _, idx in pairs(list) do
      if idx then
        local name, _, rank, maxRank = GetProfessionInfo(idx)
        if name then
          profs[name] = { rank or 0, maxRank or 0 }
        end
      end
    end
  end
  if next(profs) == nil and GetNumSkillLines then
    for i = 1, GetNumSkillLines() do
      local name, isHeader, _, rank, _, _, maxRank = GetSkillLineInfo(i)
      if name and not isHeader and PROFESSIONS[name] then
        profs[name] = { rank or 0, maxRank or 0 }
      end
    end
  end
  charData().profs = profs
end

-- ---------------------------------------------------------------------------
-- known recipes (scanned when a profession window is open)
-- ---------------------------------------------------------------------------

local function storeKnown(prof, items, spells, recipes)
  if not prof or prof == "" or prof == "UNKNOWN" then
    return
  end
  local c = charData()
  c.known[prof] = { i = items, s = spells, r = recipes, t = time() }
end

local function scanTradeSkillModern()
  if not (C_TradeSkillUI and C_TradeSkillUI.GetAllRecipeIDs) then
    return false
  end
  local ids = C_TradeSkillUI.GetAllRecipeIDs()
  if not ids or #ids == 0 then
    return false
  end
  local prof
  if C_TradeSkillUI.GetBaseProfessionInfo then
    local info = C_TradeSkillUI.GetBaseProfessionInfo()
    prof = info and (info.professionName or info.parentProfessionName)
  end
  if not prof and C_TradeSkillUI.GetTradeSkillLine then
    local _, name = C_TradeSkillUI.GetTradeSkillLine()
    prof = name
  end
  local items, spells, recipes = {}, {}, {}
  for _, rid in ipairs(ids) do
    local info = C_TradeSkillUI.GetRecipeInfo(rid)
    if info and info.learned then
      table.insert(recipes, rid)
      local link = C_TradeSkillUI.GetRecipeItemLink and C_TradeSkillUI.GetRecipeItemLink(rid)
      local item = itemIdFromLink(link)
      if not item and C_TradeSkillUI.GetRecipeOutputItemData then
        local out = C_TradeSkillUI.GetRecipeOutputItemData(rid)
        item = out and out.itemID
      end
      if item then
        table.insert(items, item)
      end
    end
  end
  storeKnown(prof, items, spells, recipes)
  return true
end

local function scanTradeSkillClassic()
  if not GetNumTradeSkills then
    return
  end
  local prof = GetTradeSkillLine and GetTradeSkillLine()
  if ExpandTradeSkillSubClass then
    safe(ExpandTradeSkillSubClass, 0)
  end
  local items, spells = {}, {}
  for i = 1, GetNumTradeSkills() do
    local _, kind = GetTradeSkillInfo(i)
    if kind and kind ~= "header" and kind ~= "subheader" then
      local item = itemIdFromLink(GetTradeSkillItemLink(i))
      if item then
        table.insert(items, item)
      end
      if GetTradeSkillRecipeLink then
        local spell = spellIdFromLink(GetTradeSkillRecipeLink(i))
        if spell then
          table.insert(spells, spell)
        end
      end
    end
  end
  storeKnown(prof, items, spells, nil)
end

local function scanCraftClassic()
  -- Classic enchanting uses the separate Craft UI.
  if not GetNumCrafts then
    return
  end
  local prof = (GetCraftDisplaySkillLine and GetCraftDisplaySkillLine()) or (GetCraftName and GetCraftName())
  local items, spells = {}, {}
  for i = 1, GetNumCrafts() do
    local _, _, kind = GetCraftInfo(i)
    if kind ~= "header" then
      local link = GetCraftItemLink and GetCraftItemLink(i)
      local item = itemIdFromLink(link)
      if item then
        table.insert(items, item)
      end
      local spell = spellIdFromLink(link) or (GetCraftRecipeLink and spellIdFromLink(GetCraftRecipeLink(i)))
      if spell then
        table.insert(spells, spell)
      end
    end
  end
  storeKnown(prof, items, spells, nil)
end

local function scanTradeSkill()
  local ok, modern = pcall(scanTradeSkillModern)
  if not (ok and modern) then
    safe(scanTradeSkillClassic)
  end
end

-- ---------------------------------------------------------------------------
-- auction ledger from mail invoices
-- ---------------------------------------------------------------------------

local function scanInvoices()
  if not (GetInboxNumItems and GetInboxInvoiceInfo) then
    return
  end
  EconomancerDB.ledger = EconomancerDB.ledger or {}
  EconomancerDB.seen = EconomancerDB.seen or {}
  local now = time()
  for i = 1, GetInboxNumItems() do
    local invoiceType, itemName, _, bid, _, deposit, consignment, _, _, _, count = GetInboxInvoiceInfo(i)
    if invoiceType == "seller" or invoiceType == "buyer" then
      local daysLeft = select(7, GetInboxHeaderInfo(i)) or 0
      local expires = now + daysLeft * 86400
      -- Expiry is fixed per mail, so it makes a stable id across scans.
      local sig = string.format("%s:%s:%d:%d", invoiceType, itemName or "?", bid or 0, math.floor(expires / 600))
      if not EconomancerDB.seen[sig] then
        EconomancerDB.seen[sig] = expires
        local sentAt = expires - 30 * 86400
        if sentAt > now then
          sentAt = now
        end
        table.insert(EconomancerDB.ledger, {
          t = math.floor(sentAt),
          k = invoiceType == "seller" and "s" or "b",
          n = itemName,
          q = count or 1,
          a = bid or 0,
          c = consignment or 0,
          d = deposit or 0,
          ch = charKey,
        })
      end
    end
  end
  -- prune
  local cutoff = now - LEDGER_KEEP_DAYS * 86400
  local kept = {}
  for _, e in ipairs(EconomancerDB.ledger) do
    if e.t >= cutoff then
      table.insert(kept, e)
    end
  end
  EconomancerDB.ledger = kept
  for sig, exp in pairs(EconomancerDB.seen) do
    if exp < now - 86400 then
      EconomancerDB.seen[sig] = nil
    end
  end
end

-- ---------------------------------------------------------------------------
-- export (compact JSON; '|' is escaped because WoW edit boxes treat it as a control code)
-- ---------------------------------------------------------------------------

local function isArray(t)
  local n = 0
  for k in pairs(t) do
    if type(k) ~= "number" then
      return false
    end
    n = n + 1
  end
  for i = 1, n do
    if t[i] == nil then
      return false
    end
  end
  return true
end

local function encode(v, out)
  local tv = type(v)
  if tv == "nil" then
    table.insert(out, "null")
  elseif tv == "boolean" then
    table.insert(out, v and "true" or "false")
  elseif tv == "number" then
    if v == math.floor(v) then
      table.insert(out, string.format("%d", v))
    else
      table.insert(out, string.format("%.2f", v))
    end
  elseif tv == "string" then
    local s = v:gsub('[%c"\\|]', function(ch)
      return string.format("\\u%04x", ch:byte())
    end)
    table.insert(out, '"' .. s .. '"')
  elseif tv == "table" then
    if next(v) == nil then
      table.insert(out, "[]")
    elseif isArray(v) then
      table.insert(out, "[")
      for i, x in ipairs(v) do
        if i > 1 then
          table.insert(out, ",")
        end
        encode(x, out)
      end
      table.insert(out, "]")
    else
      table.insert(out, "{")
      local first = true
      for k, x in pairs(v) do
        if not first then
          table.insert(out, ",")
        end
        first = false
        encode(tostring(k), out)
        table.insert(out, ":")
        encode(x, out)
      end
      table.insert(out, "}")
    end
  end
end

local function buildExport()
  local now = time()
  local chars = {}
  for key, c in pairs(EconomancerDB.chars or {}) do
    chars[key] = {
      g = c.gold or 0,
      f = c.faction,
      l = c.level,
      p = c.profs or {},
      k = c.known or {},
      bags = c.bags or {},
      bank = c.bank or {},
      ts = c.scanned,
      tb = c.bankScanned,
    }
  end
  local ledger = {}
  local cutoff = now - EXPORT_LEDGER_DAYS * 86400
  for _, e in ipairs(EconomancerDB.ledger or {}) do
    if e.t >= cutoff then
      table.insert(ledger, { e.t, e.k, e.n, e.q, e.a, e.c, e.ch })
    end
  end
  local out = {}
  encode({ v = 1, addon = VERSION, at = now, chars = chars, ledger = ledger }, out)
  return "ECON1:" .. table.concat(out)
end

local exportFrame
local function showExport()
  scanBags()
  scanProfessions()
  local text = buildExport()
  if not exportFrame then
    local ok, frame = pcall(CreateFrame, "Frame", "EconomancerExport", UIParent, "BasicFrameTemplateWithInset")
    if not ok or not frame then
      frame = CreateFrame("Frame", "EconomancerExport", UIParent, BackdropTemplateMixin and "BackdropTemplate" or nil)
      if frame.SetBackdrop then
        frame:SetBackdrop({ bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background", edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border", edgeSize = 16, insets = { left = 4, right = 4, top = 4, bottom = 4 } })
      end
      local close = CreateFrame("Button", nil, frame, "UIPanelCloseButton")
      close:SetPoint("TOPRIGHT", -2, -2)
    end
    frame:SetSize(520, 340)
    frame:SetPoint("CENTER")
    frame:SetMovable(true)
    frame:EnableMouse(true)
    frame:RegisterForDrag("LeftButton")
    frame:SetScript("OnDragStart", frame.StartMoving)
    frame:SetScript("OnDragStop", frame.StopMovingOrSizing)
    frame:SetFrameStrata("DIALOG")
    table.insert(UISpecialFrames, "EconomancerExport")

    local title = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
    title:SetPoint("TOP", 0, -6)
    title:SetText("Economancer export — Ctrl+C, then paste on the website")

    local scroll = CreateFrame("ScrollFrame", "EconomancerExportScroll", frame, "UIPanelScrollFrameTemplate")
    scroll:SetPoint("TOPLEFT", 12, -32)
    scroll:SetPoint("BOTTOMRIGHT", -32, 12)
    local edit = CreateFrame("EditBox", nil, scroll)
    edit:SetMultiLine(true)
    edit:SetAutoFocus(false)
    edit:SetFontObject(ChatFontNormal)
    edit:SetWidth(460)
    edit:SetScript("OnEscapePressed", function()
      frame:Hide()
    end)
    edit:SetScript("OnTextChanged", function(self, user)
      if user then
        self:SetText(frame.exportText or "")
        self:HighlightText()
      end
    end)
    scroll:SetScrollChild(edit)
    frame.edit = edit
    exportFrame = frame
  end
  exportFrame.exportText = text
  exportFrame.edit:SetText(text)
  exportFrame:Show()
  exportFrame.edit:SetFocus()
  exportFrame.edit:HighlightText()
  local nChars = 0
  for _ in pairs(EconomancerDB.chars or {}) do
    nChars = nChars + 1
  end
  print(string.format("|cffe5b94eEconomancer|r: export ready (%d character%s, %d bytes). Open your bank and each profession window once so they're included.", nChars, nChars == 1 and "" or "s", #text))
end

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------

f:RegisterEvent("PLAYER_LOGIN")
f:SetScript("OnEvent", function(_, event)
  if event == "PLAYER_LOGIN" then
    charKey = (UnitName("player") or "?") .. "-" .. (GetRealmName() or "?")
    local c = charData()
    c.faction = UnitFactionGroup("player")
    c.level = UnitLevel("player")
    for _, e in ipairs({
      "BAG_UPDATE_DELAYED", "PLAYER_MONEY", "BANKFRAME_OPENED", "BANKFRAME_CLOSED", "PLAYERBANKSLOTS_CHANGED",
      "TRADE_SKILL_SHOW", "TRADE_SKILL_UPDATE", "TRADE_SKILL_LIST_UPDATE", "CRAFT_SHOW", "CRAFT_UPDATE",
      "MAIL_INBOX_UPDATE", "SKILL_LINES_CHANGED", "PLAYER_LEVEL_UP", "PLAYER_LOGOUT",
    }) do
      pcall(f.RegisterEvent, f, e)
    end
    safe(scanBags)
    safe(scanProfessions)
    return
  end
  if event == "BAG_UPDATE_DELAYED" or event == "PLAYER_MONEY" then
    safe(scanBags)
    if bankOpen then
      safe(scanBank)
    end
  elseif event == "BANKFRAME_OPENED" then
    bankOpen = true
    safe(scanBank)
  elseif event == "PLAYERBANKSLOTS_CHANGED" then
    safe(scanBank)
  elseif event == "BANKFRAME_CLOSED" then
    bankOpen = false
  elseif event == "TRADE_SKILL_SHOW" or event == "TRADE_SKILL_UPDATE" or event == "TRADE_SKILL_LIST_UPDATE" then
    safe(scanTradeSkill)
  elseif event == "CRAFT_SHOW" or event == "CRAFT_UPDATE" then
    safe(scanCraftClassic)
  elseif event == "MAIL_INBOX_UPDATE" then
    safe(scanInvoices)
  elseif event == "SKILL_LINES_CHANGED" then
    safe(scanProfessions)
  elseif event == "PLAYER_LEVEL_UP" then
    charData().level = UnitLevel("player")
  elseif event == "PLAYER_LOGOUT" then
    safe(scanBags)
    charData().level = UnitLevel("player")
  end
end)

SLASH_ECONOMANCER1 = "/econ"
SLASH_ECONOMANCER2 = "/economancer"
SlashCmdList.ECONOMANCER = function(msg)
  msg = (msg or ""):lower()
  if msg == "reset" then
    EconomancerDB = {}
    charData()
    print("|cffe5b94eEconomancer|r: data cleared.")
    return
  end
  if msg == "forget" then
    EconomancerDB.chars[charKey] = nil
    print("|cffe5b94eEconomancer|r: this character's data cleared.")
    return
  end
  showExport()
end
