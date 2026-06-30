from django.urls import path

from . import views

urlpatterns = [
    # Template
    path('', views.index, name='index'),

    # REST API endpoints
    path('api/stats/',    views.StatsView.as_view(),    name='api_stats'),
    path('api/search/',   views.SearchView.as_view(),   name='api_search'),
]
