package deploy

// ParamSpec 工具参数定义（前端根据 schema 动态渲染表单）
type ParamSpec struct {
	Key         string        `json:"key"`
	Label       string        `json:"label"`
	Type        string        `json:"type"` // text | password | email | select
	Required    bool          `json:"required"`
	Default     string        `json:"default"`
	Placeholder string        `json:"placeholder,omitempty"`
	Help        string        `json:"help,omitempty"`
	Options     []ParamOption `json:"options,omitempty"`
}

// ParamOption select 类型的选项
type ParamOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

// ApplyParamDefaults 对参数应用默认值（缺失时填入）
func ApplyParamDefaults(schema []ParamSpec, params map[string]string) map[string]string {
	if params == nil {
		params = map[string]string{}
	}
	for _, spec := range schema {
		if _, ok := params[spec.Key]; !ok && spec.Default != "" {
			params[spec.Key] = spec.Default
		}
	}
	return params
}

// ValidateParams 校验必填
func ValidateParams(schema []ParamSpec, params map[string]string) error {
	for _, spec := range schema {
		if spec.Required {
			v, ok := params[spec.Key]
			if !ok || v == "" {
				return &ParamValidationError{Key: spec.Key}
			}
		}
	}
	return nil
}

// ParamValidationError 必填参数缺失
type ParamValidationError struct{ Key string }

func (e *ParamValidationError) Error() string { return "missing required param: " + e.Key }
