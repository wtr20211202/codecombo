package store

import (
	"encoding/json"

	"codecombo/server/config"
)

// TemplateStore 提交模板存储
type TemplateStore interface {
	List() ([]config.CommitTemplate, error)
	Create(t config.CommitTemplate) error
	Delete(name string) error
}

type templateRepo struct{ doc DocumentStore }

func (r *templateRepo) List() ([]config.CommitTemplate, error) {
	keys, _, err := r.doc.List("templates", ListOpts{})
	if err != nil {
		return nil, err
	}
	result := make([]config.CommitTemplate, 0, len(keys))
	for _, key := range keys {
		data, _ := r.doc.Get("templates", key)
		var t config.CommitTemplate
		if json.Unmarshal(data, &t) == nil {
			result = append(result, t)
		}
	}
	return result, nil
}

func (r *templateRepo) Create(t config.CommitTemplate) error {
	data, err := json.Marshal(t)
	if err != nil {
		return err
	}
	return r.doc.Create("templates", t.Name, data)
}

func (r *templateRepo) Delete(name string) error {
	return r.doc.Delete("templates", name)
}
