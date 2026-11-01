import { describe, it, expect } from 'vitest'
import { extractTemplateParams, interpolateTemplate } from '@/utils/textTemplate'

describe('extractTemplateParams', () => {
  it('按出现顺序提取去重参数名', () => {
    expect(extractTemplateParams('docker exec -it {{容器}} {{容器}} sh')).toEqual(['容器'])
    expect(extractTemplateParams('scp {{src}} {{dst}}')).toEqual(['src', 'dst'])
  })

  it('容忍占位符内空白', () => {
    expect(extractTemplateParams('ping {{ 主机 }}')).toEqual(['主机'])
  })

  it('无占位符返回空数组；未闭合不误报', () => {
    expect(extractTemplateParams('ls -la')).toEqual([])
    expect(extractTemplateParams('echo {{oops')).toEqual([])
  })

  it('单大括号 {name} 形式（P-20261002-123）', () => {
    expect(extractTemplateParams('scp {src} {dst}')).toEqual(['src', 'dst'])
    expect(extractTemplateParams('kubectl logs -f {pod} -n {ns}')).toEqual(['pod', 'ns'])
    expect(extractTemplateParams('tail {f} {f}')).toEqual(['f'])
  })

  it('单双形式可混用；参数名允许点横线', () => {
    expect(extractTemplateParams('cp {src} {{dst}}')).toEqual(['src', 'dst'])
    expect(extractTemplateParams('tar -czf {out.tar.gz} {dir}')).toEqual(['out.tar.gz', 'dir'])
  })

  it('{{ 字面转义：awk/sed 类字面花括号不误报', () => {
    expect(extractTemplateParams("awk '{{print $1}}'")).toEqual([])
    expect(extractTemplateParams('echo {{oops')).toEqual([])
    expect(extractTemplateParams("sed 's/{{x}/y/'")).toEqual([])
    // 旧双大括号形式仍优先按占位符识别（兼容既有片段数据）
    expect(extractTemplateParams("sed 's/{{x}}/y/'")).toEqual(['x'])
  })

  it('不合占位符名的花括号原样保留（${VAR}、JSON）', () => {
    expect(extractTemplateParams('echo ${VAR}')).toEqual([])
    expect(extractTemplateParams('curl -d \'{"k":1}\'')).toEqual([])
    expect(extractTemplateParams('echo {}')).toEqual([])
  })
})

describe('interpolateTemplate', () => {
  it('替换已填写参数', () => {
    expect(interpolateTemplate('scp {{src}} {{dst}}', { src: 'a.txt', dst: '/tmp' })).toBe('scp a.txt /tmp')
  })

  it('未填写参数保留原样（不静默清空）', () => {
    expect(interpolateTemplate('scp {{src}} {{dst}}', { src: 'a.txt' })).toBe('scp a.txt {{dst}}')
  })

  it('空白值视同未填写；同名参数全部替换', () => {
    expect(interpolateTemplate('exec -it {{c}} {{c}}', { c: '  ' })).toBe('exec -it {{c}} {{c}}')
    expect(interpolateTemplate('exec -it {{c}} {{c}}', { c: 'box' })).toBe('exec -it box box')
  })

  it('无占位符原样返回', () => {
    expect(interpolateTemplate('ls -la', {})).toBe('ls -la')
  })

  it('单大括号形式插值；未填保留原样', () => {
    expect(interpolateTemplate('scp {src} {dst}', { src: 'a.txt', dst: '/tmp' })).toBe('scp a.txt /tmp')
    expect(interpolateTemplate('scp {src} {dst}', { src: 'a.txt' })).toBe('scp a.txt {dst}')
    expect(interpolateTemplate('logs {f}', { f: ' ' })).toBe('logs {f}')
  })

  it('{{ 转义输出字面 {（awk 命令经插值原样还原）', () => {
    expect(interpolateTemplate("awk '{{print $1}}'", {})).toBe("awk '{print $1}'")
    expect(interpolateTemplate('echo {{oops', {})).toBe('echo {oops')
    expect(interpolateTemplate('echo ${VAR}', {})).toBe('echo ${VAR}')
    expect(interpolateTemplate('curl -d \'{"k":1}\'', {})).toBe('curl -d \'{"k":1}\'')
  })

  it('占位符与转义混合：填值只动占位符', () => {
    expect(interpolateTemplate('run {name} --awk {{print $1}}', { name: 'job1' }))
      .toBe('run job1 --awk {print $1}')
  })
})
