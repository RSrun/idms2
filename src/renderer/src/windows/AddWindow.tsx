import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  CategoryId,
  DownloadWindowRequest,
  Settings,
  UrlProbeResult
} from '@shared/types'
import { useT } from '../i18n'
import { formatBytes } from '../format'
import {
  baseOf,
  categoryForName,
  dirOf,
  fileBadge,
  joinPath,
  nameFromUrl
} from './shared'

const BUILTIN: CategoryId[] = ['video', 'audio', 'archive', 'program', 'document', 'other']

interface Props {
  request: DownloadWindowRequest
  settings: Settings
}

/**
 * IDM'nin "Dosya İndirme Bilgisi" penceresi: URL, kategori, kayıt yolu,
 * kategori için yolu hatırla, açıklama, boyut ve Önizleme.
 */
export function AddWindow({ request, settings }: Props) {
  const t = useT()
  const initialName = request.name || nameFromUrl(request.url)
  const [url, setUrl] = useState(request.url)
  const [category, setCategory] = useState<string>(
    request.category || categoryForName(initialName)
  )
  const [savePath, setSavePath] = useState(
    request.savePath || joinPath(dirFor(request.category || categoryForName(initialName), settings), initialName)
  )
  const [description, setDescription] = useState(request.description || '')
  const [remember, setRemember] = useState(false)
  const [probe, setProbe] = useState<UrlProbeResult | null>(null)
  const [probing, setProbing] = useState(false)
  const [error, setError] = useState('')
  const [newCategoryOpen, setNewCategoryOpen] = useState(false)
  const [newCategory, setNewCategory] = useState('')
  const [customCats, setCustomCats] = useState<Array<{ name: string; dir: string }>>(
    settings.general.customCategories || []
  )
  const nameTouched = useRef(!!request.name)
  const pathTouched = useRef(!!request.savePath)
  const categoryTouched = useRef(!!request.category)
  const urlRef = useRef<HTMLInputElement>(null)

  const categoryLabel = useMemo(() => {
    const custom = customCats.find((c) => c.name === category)
    if (custom) return custom.name
    const builtin = category as CategoryId
    return BUILTIN.includes(builtin) ? t(`cat.${builtin}` as any) : category
  }, [category, customCats, t])

  useEffect(() => {
    urlRef.current?.focus()
    void runProbe(request.url)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function currentDir(cat: string): string {
    const custom = customCats.find((c) => c.name === cat)
    if (custom) return custom.dir
    const remembered = settings.general.categoryDirs?.[cat]
    if (remembered) return remembered
    return joinPath(settings.general.downloadDir, cat)
  }

  function applyCategory(cat: string): void {
    categoryTouched.current = true
    setCategory(cat)
    const name = baseOf(savePath) || initialName
    setSavePath(joinPath(currentDir(cat), name))
    pathTouched.current = false
  }

  async function runProbe(raw: string): Promise<void> {
    const u = raw.trim()
    if (!/^https?:\/\//i.test(u)) {
      setProbe(null)
      return
    }
    setProbing(true)
    setError('')
    try {
      const res = await window.idms2.probeUrl(u)
      setProbe(res)
      if (res.ok && res.name && res.name !== 'download' && !nameTouched.current) {
        const next = res.name
        if (!pathTouched.current) {
          setSavePath((p) => joinPath(dirOf(p), next))
        }
        if (!request.category) {
          const inferred = categoryForName(next)
          if (inferred !== category) {
            setCategory(inferred)
            if (!pathTouched.current) {
              setSavePath(joinPath(currentDir(inferred), next))
            }
          }
        }
      }
      if (!res.ok) setError(t('add.probeFailed'))
    } catch {
      setError(t('add.probeFailed'))
    } finally {
      setProbing(false)
    }
  }

  async function browse(): Promise<void> {
    const dir = await window.idms2.pickDirectory(dirOf(savePath))
    if (!dir) return
    const name = baseOf(savePath) || initialName
    setSavePath(joinPath(dir, name))
    pathTouched.current = true
  }

  async function addNewCategory(): Promise<void> {
    const name = newCategory.trim().replace(/[<>:"/\\|?*]/g, '_')
    if (!name) return
    const dir = joinPath(settings.general.downloadDir, name)
    const list = [...customCats.filter((c) => c.name !== name), { name, dir }]
    setCustomCats(list)
    categoryTouched.current = true
    setCategory(name)
    setSavePath(joinPath(dir, baseOf(savePath) || initialName))
    setNewCategoryOpen(false)
    setNewCategory('')
    await window.idms2.patchSettings({ general: { customCategories: list } })
  }

  async function submit(start: boolean): Promise<void> {
    const u = url.trim()
    if (!/^https?:\/\//i.test(u)) {
      setError(t('win.add.invalidUrl'))
      urlRef.current?.focus()
      return
    }

    // Kullanıcı yolu elle değiştirmediyse adresden gelen adı kullan.
    // (Yapıştırıp doğrudan "İndirmeyi Başlat"a basınca "download" adı kalmasın.)
    const probed = probe?.ok && probe.url === u ? probe.name : ''
    const derived = probed && probed !== 'download' ? probed : nameFromUrl(u)
    const name = pathTouched.current ? baseOf(savePath) || initialName : derived
    const finalCategory =
      !request.category && !categoryTouched.current ? categoryForName(name) : category
    const finalPath = pathTouched.current
      ? savePath
      : joinPath(currentDir(finalCategory), name)
    const builtin = BUILTIN.includes(finalCategory as CategoryId)
      ? (finalCategory as CategoryId)
      : 'other'

    if (remember) {
      const dir = dirOf(finalPath)
      const dirs = { ...(settings.general.categoryDirs || {}), [finalCategory]: dir }
      await window.idms2.patchSettings({ general: { categoryDirs: dirs } })
    }
    const next: DownloadWindowRequest = {
      url: u,
      pageUrl: request.pageUrl,
      name,
      savePath: finalPath,
      category: builtin,
      description: description.trim() || undefined,
      start
    }
    await window.dlwin.action({
      type: start ? 'add-start' : 'add-later',
      request: next,
      remember: false
    })
  }

  const badge = fileBadge(baseOf(savePath) || initialName)
  const size = probe?.ok ? probe.sizeBytes : null

  return (
    <div className="dlwin addwin">
      <div className="add-main">
        <div className="field-row">
          <label htmlFor="dl-url">{t('win.add.url')}</label>
          <input
            id="dl-url"
            ref={urlRef}
            className="text"
            value={url}
            spellCheck={false}
            onChange={(e) => {
              setUrl(e.target.value)
              pathTouched.current = false
              nameTouched.current = false
            }}
            onBlur={() => void runProbe(url)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runProbe(url)
            }}
          />
        </div>

        <div className="field-row">
          <label htmlFor="dl-cat">{t('win.add.category')}</label>
          <div className="cat-line">
            <select
              id="dl-cat"
              className="select"
              value={category}
              onChange={(e) => applyCategory(e.target.value)}
            >
              {BUILTIN.map((c) => (
                <option key={c} value={c}>
                  {t(`cat.${c}` as any)}
                </option>
              ))}
              {customCats.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="square"
              title={t('win.add.newCategory')}
              onClick={() => setNewCategoryOpen((v) => !v)}
            >
              +
            </button>
          </div>
        </div>

        {newCategoryOpen && (
          <div className="field-row sub-line">
            <span />
            <div className="new-cat">
              <input
                className="text"
                autoFocus
                placeholder={t('win.add.newCategoryPlaceholder')}
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addNewCategory()
                  if (e.key === 'Escape') setNewCategoryOpen(false)
                }}
              />
              <button type="button" className="btn" onClick={() => void addNewCategory()}>
                {t('win.add.addCategory')}
              </button>
            </div>
          </div>
        )}

        <div className="field-row">
          <label htmlFor="dl-path">{t('win.add.saveAs')}</label>
          <div className="path-line">
            <input
              id="dl-path"
              className="text"
              value={savePath}
              spellCheck={false}
              onChange={(e) => {
                setSavePath(e.target.value)
                pathTouched.current = true
                nameTouched.current = true
              }}
            />
            <button type="button" className="square" title={t('common.browse')} onClick={() => void browse()}>
              …
            </button>
          </div>
        </div>

        <div className="field-row">
          <span />
          <label className="check">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            {t('win.add.rememberCategory', { category: categoryLabel })}
          </label>
        </div>

        <div className="field-row">
          <span />
          <input className="text remembered" value={dirOf(savePath)} readOnly tabIndex={-1} />
        </div>

        <div className="field-row">
          <label htmlFor="dl-desc">{t('win.add.description')}</label>
          <input
            id="dl-desc"
            className="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="add-actions">
          <button type="button" className="btn" onClick={() => void submit(false)}>
            {t('win.add.later')}
          </button>
          <button type="button" className="btn primary" onClick={() => void submit(true)}>
            {t('win.add.start')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void window.dlwin.action({ type: 'add-cancel' })}
          >
            {t('common.cancel')}
          </button>
        </div>

        {(probing || error) && (
          <div className={`notice ${error ? 'bad' : ''}`}>
            {error || (
              <>
                <span className="spin" /> {t('win.add.probing')}
              </>
            )}
          </div>
        )}
      </div>

      <aside className="add-side">
        <div className={`file-badge ${badge.kind}`}>{badge.text}</div>
        <div className="file-size">
          {size !== null
            ? formatBytes(size)
            : probe?.ok === false
              ? '—'
              : t('win.add.sizeUnknown')}
        </div>
        <button
          type="button"
          className="btn preview"
          onClick={() => {
            if (/^https?:\/\//i.test(url.trim())) void window.idms2.openExternal(url.trim())
          }}
        >
          {t('win.add.preview')}
        </button>
      </aside>
    </div>
  )
}

function dirFor(category: CategoryId | string, settings: Settings): string {
  const remembered = settings.general.categoryDirs?.[category]
  if (remembered) return remembered
  const custom = settings.general.customCategories?.find((c) => c.name === category)
  if (custom) return custom.dir
  return joinPath(settings.general.downloadDir, String(category))
}
